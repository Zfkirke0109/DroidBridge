//! `content://` targets on the root host. The daemon reaches content providers through the
//! platform `content` command run as root under its own guard; no App process takes part.
//!
//! The command prints each row as `Row: <n> <column>=<value>, <column>=<value>` with `NULL` for a
//! null value, writes provider failures to standard error and always exits 0. Values are free
//! text, so a row is split only at the exact `, <next column>=` boundary of the requested
//! projection, and a row in which that boundary is ambiguous is refused instead of guessed.

use crate::{command::RootCommandGuard, visual::ExecutionTempFile};
use contract::{ErrorCode, FileEntry, FileTarget, FileTargetType, FileType};
use contract::{FilesystemInspectInput, FilesystemInspectResult};
use domain::DomainError;
use runtime::{
    AdmittedExecution, CommandProcessOutcome, ExecutionFailure, FilesystemFrameworkPort,
    FilesystemFrameworkSource, LocalExecutionClaim, ProviderToken,
};
use std::{path::PathBuf, sync::Arc};

const MAX_URI_BYTES: usize = 4_096;
const MAX_DOCUMENT_NAME_BYTES: usize = 4_096;
const QUERY_OUTPUT_BYTES: u64 = 8 * 1_024 * 1_024;
/// The largest content stream a read takes in. The command cannot seek, so a longer stream is
/// refused rather than cut short.
const READ_LIMIT_BYTES: u64 = 64 * 1_024 * 1_024;
const MAX_PEER_REASON_BYTES: usize = 512;
const MIME_TYPE_DIR: &str = "vnd.android.document/directory";
/// The document columns, with the free-text ones last so each boundary is checked once.
const DOCUMENT_COLUMNS: [&str; 5] = [
    "mime_type",
    "_size",
    "last_modified",
    "document_id",
    "_display_name",
];
const OPENABLE_COLUMNS: [&str; 2] = ["_size", "_display_name"];

#[derive(Clone)]
pub(crate) struct RootContentPort {
    canonical_base: PathBuf,
    root: Arc<RootCommandGuard>,
}

impl RootContentPort {
    pub(crate) fn new(canonical_base: PathBuf, root: Arc<RootCommandGuard>) -> Self {
        Self {
            canonical_base,
            root,
        }
    }

    fn query(
        &self,
        execution: &AdmittedExecution,
        uri: &str,
        columns: &[&str],
        claim: &LocalExecutionClaim,
    ) -> Result<Vec<Vec<Option<String>>>, DomainError> {
        let outcome = self.run(
            execution,
            vec![
                "query".to_owned(),
                "--uri".to_owned(),
                uri.to_owned(),
                "--projection".to_owned(),
                columns.join(":"),
            ],
            None,
            QUERY_OUTPUT_BYTES,
            claim,
        )?;
        if outcome.stdout_truncated {
            return Err(DomainError::new(
                ErrorCode::ResourceLimit,
                "content query output exceeds its bound",
            ));
        }
        provider_verdict(&outcome.stderr)?;
        parse_rows(&outcome.stdout, columns)
    }

    fn run(
        &self,
        execution: &AdmittedExecution,
        arguments: Vec<String>,
        output: Option<&std::fs::File>,
        max_output_bytes: u64,
        claim: &LocalExecutionClaim,
    ) -> Result<CommandProcessOutcome, DomainError> {
        self.root
            .run_content(
                &execution.execution_id,
                arguments,
                output,
                max_output_bytes,
                claim,
            )
            .map_err(|failure| unverified(failure, claim))
    }

    fn metadata(
        &self,
        execution: &AdmittedExecution,
        uri: &ContentUri,
        claim: &LocalExecutionClaim,
    ) -> Result<ContentMetadata, DomainError> {
        if uri.is_tree() || uri.is_document() {
            let target = if uri.is_tree() {
                uri.tree_document_uri()?
            } else {
                uri.value.clone()
            };
            let rows = self.query(execution, &target, &DOCUMENT_COLUMNS, claim)?;
            let row = rows.into_iter().next().ok_or_else(not_found)?;
            return document_metadata(row);
        }
        let rows = self.query(execution, &uri.value, &OPENABLE_COLUMNS, claim)?;
        let mut row = rows.into_iter().next().ok_or_else(not_found)?;
        Ok(ContentMetadata {
            document_id: None,
            name: row.pop().flatten().unwrap_or_default(),
            directory: false,
            size: row.pop().flatten().and_then(|value| size(&value)),
            modified_at: None,
        })
    }
}

impl FilesystemFrameworkPort for RootContentPort {
    fn inspect(
        &self,
        execution: &AdmittedExecution,
        input: FilesystemInspectInput,
        claim: &LocalExecutionClaim,
    ) -> Result<FilesystemInspectResult, DomainError> {
        require_root_provider(execution)?;
        if !(1..=16).contains(&input.max_depth)
            || !(1..=5_000).contains(&input.max_entries)
            || (!input.recursive && input.max_depth != 1)
        {
            return Err(DomainError::invalid("invalid content inspect bounds"));
        }
        let uri = ContentUri::parse(&input.target)?;
        let metadata = self.metadata(execution, &uri, claim)?;
        if !metadata.directory {
            return Ok(FilesystemInspectResult {
                target: input.target,
                target_type: FileType::File,
                size: metadata.size,
                modified_at: metadata.modified_at,
                entries: None,
                truncated: None,
            });
        }
        if !uri.is_tree() {
            return Err(DomainError::new(
                ErrorCode::Unsupported,
                "only a document tree URI can be listed",
            ));
        }
        let mut entries = Vec::new();
        let mut truncated = false;
        let mut pending = vec![(uri.tree_document_id()?, String::new(), 1_u32)];
        while let Some((document_id, prefix, depth)) = pending.pop() {
            claim.checkpoint()?;
            let children = uri.children_uri(&document_id)?;
            let mut nested = Vec::new();
            for row in self.query(execution, &children, &DOCUMENT_COLUMNS, claim)? {
                if entries.len() == input.max_entries as usize {
                    truncated = true;
                    break;
                }
                let child = document_metadata(row)?;
                let name = safe_document_name(&child.name)?;
                let name = if prefix.is_empty() {
                    name.to_owned()
                } else {
                    format!("{prefix}/{name}")
                };
                if input.recursive && child.directory && depth < input.max_depth {
                    nested.push((
                        child
                            .document_id
                            .clone()
                            .ok_or_else(|| io_error("content child has no document id"))?,
                        name.clone(),
                        depth + 1,
                    ));
                }
                entries.push(FileEntry {
                    name,
                    entry_type: if child.directory {
                        FileType::Directory
                    } else {
                        FileType::File
                    },
                    size: child.size,
                    modified_at: child.modified_at,
                });
            }
            if truncated {
                break;
            }
            // Children are listed before the next sibling's subtree, in provider order.
            pending.extend(nested.into_iter().rev());
        }
        Ok(FilesystemInspectResult {
            target: input.target,
            target_type: FileType::Directory,
            size: metadata.size,
            modified_at: metadata.modified_at,
            entries: Some(entries),
            truncated: Some(truncated),
        })
    }

    fn open_read(
        &self,
        execution: &AdmittedExecution,
        target: &FileTarget,
        claim: &LocalExecutionClaim,
    ) -> Result<FilesystemFrameworkSource, DomainError> {
        require_root_provider(execution)?;
        let uri = ContentUri::parse(target)?;
        let output = ExecutionTempFile::create(
            &self.canonical_base,
            &execution.execution_id,
            "content-read",
        )?;
        let outcome = self.run(
            execution,
            vec!["read".to_owned(), "--uri".to_owned(), uri.value.clone()],
            Some(output.writer()),
            READ_LIMIT_BYTES,
            claim,
        )?;
        provider_verdict(&outcome.stderr)?;
        if outcome.stdout_truncated {
            return Err(DomainError::new(
                ErrorCode::ResourceLimit,
                "content stream exceeds the root read bound",
            ));
        }
        let file = output.persist_for_read()?;
        let total_size = file
            .metadata()
            .map_err(|error| DomainError::os(ErrorCode::IoError, "cannot stat content", &error))?
            .len();
        Ok(FilesystemFrameworkSource {
            file,
            total_size: Some(total_size),
        })
    }
}

/// Opens [source] for the visual transform, which reads it through its own path.
pub(crate) fn open_content_image(
    port: &RootContentPort,
    execution: &AdmittedExecution,
    value: String,
    claim: &LocalExecutionClaim,
) -> Result<std::fs::File, DomainError> {
    port.open_read(
        execution,
        &FileTarget {
            target_type: FileTargetType::ContentUri,
            value,
        },
        claim,
    )
    .map(|source| source.file)
}

fn require_root_provider(execution: &AdmittedExecution) -> Result<(), DomainError> {
    if execution.executor.provider != ProviderToken::MagiskNative {
        return Err(DomainError::new(
            ErrorCode::StaleAuthority,
            "content execution provider is not the root host",
        ));
    }
    Ok(())
}

/// Records a process whose cleanup the guard could not verify on the execution itself.
fn unverified(failure: ExecutionFailure, claim: &LocalExecutionClaim) -> DomainError {
    if !failure.cleanup_verified {
        claim.mark_cleanup_unverified();
    }
    failure.error
}

/// The provider's verdict from the command's standard error, which is empty on success.
fn provider_verdict(stderr: &[u8]) -> Result<(), DomainError> {
    let text = String::from_utf8_lossy(stderr);
    let text = text.trim();
    if text.is_empty() {
        return Ok(());
    }
    let (code, reason) = if text.contains("java.io.FileNotFoundException")
        || text.contains("Could not find provider")
    {
        (ErrorCode::NotFound, "content provider has no such target")
    } else if text.contains("java.lang.SecurityException") {
        (
            ErrorCode::PermissionDenied,
            "content provider refused the root caller",
        )
    } else if text.contains("java.lang.UnsupportedOperationException") {
        (
            ErrorCode::Unsupported,
            "content provider does not support the operation",
        )
    } else if text.contains("java.lang.IllegalArgumentException") {
        (
            ErrorCode::InvalidArgument,
            "content provider rejected the URI",
        )
    } else {
        (ErrorCode::IoError, "content command failed")
    };
    let mut error = DomainError::new(code, reason);
    error.peer_reason = Some(bounded_reason(text));
    Err(error)
}

fn bounded_reason(text: &str) -> String {
    // The exception names the cause; the command's own banner only names the provider.
    let line = text
        .lines()
        .find(|line| line.contains("Exception"))
        .unwrap_or(text)
        .trim();
    let mut end = line.len().min(MAX_PEER_REASON_BYTES);
    while !line.is_char_boundary(end) {
        end -= 1;
    }
    line[..end].to_owned()
}

/// Splits the command's rows into the requested columns, `None` for a null value.
fn parse_rows(stdout: &[u8], columns: &[&str]) -> Result<Vec<Vec<Option<String>>>, DomainError> {
    let text =
        std::str::from_utf8(stdout).map_err(|_| io_error("content query output is not UTF-8"))?;
    let text = text.strip_suffix('\n').unwrap_or(text);
    if text.trim() == "No result found." || text.is_empty() {
        return Ok(Vec::new());
    }
    let mut rows: Vec<String> = Vec::new();
    for line in text.split('\n') {
        let prefix = format!("Row: {} ", rows.len());
        match line.strip_prefix(&prefix) {
            Some(row) => rows.push(row.to_owned()),
            // A value with a line break continues on the next line.
            None => rows
                .last_mut()
                .ok_or_else(|| io_error("content query output has no row"))?
                .extend(["\n", line]),
        }
    }
    rows.iter().map(|row| split_row(row, columns)).collect()
}

fn split_row(row: &str, columns: &[&str]) -> Result<Vec<Option<String>>, DomainError> {
    let mut rest = row
        .strip_prefix(&format!("{}=", columns[0]))
        .ok_or_else(|| io_error("content row does not match its projection"))?;
    let mut values = Vec::with_capacity(columns.len());
    for next in &columns[1..] {
        let boundary = format!(", {next}=");
        let mut found = rest.match_indices(&boundary);
        let (index, _) = found
            .next()
            .ok_or_else(|| io_error("content row does not match its projection"))?;
        if found.next().is_some() {
            return Err(io_error("content row is ambiguous"));
        }
        values.push(value(&rest[..index]));
        rest = &rest[index + boundary.len()..];
    }
    values.push(value(rest));
    Ok(values)
}

fn value(text: &str) -> Option<String> {
    (text != "NULL").then(|| text.to_owned())
}

struct ContentMetadata {
    document_id: Option<String>,
    name: String,
    directory: bool,
    size: Option<u64>,
    modified_at: Option<String>,
}

fn document_metadata(mut row: Vec<Option<String>>) -> Result<ContentMetadata, DomainError> {
    if row.len() != DOCUMENT_COLUMNS.len() {
        return Err(io_error("content document row is incomplete"));
    }
    let name = row.pop().flatten().unwrap_or_default();
    let document_id = row.pop().flatten();
    let modified_at = row
        .pop()
        .flatten()
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value >= 0)
        .and_then(chrono::DateTime::<chrono::Utc>::from_timestamp_millis)
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    let size = row.pop().flatten().and_then(|value| size(&value));
    let directory = row.pop().flatten().as_deref() == Some(MIME_TYPE_DIR);
    Ok(ContentMetadata {
        document_id,
        name,
        directory,
        size,
        modified_at,
    })
}

fn size(value: &str) -> Option<u64> {
    value.parse().ok()
}

fn safe_document_name(value: &str) -> Result<&str, DomainError> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.contains('/')
        || value.contains('\0')
        || value.len() > MAX_DOCUMENT_NAME_BYTES
    {
        return Err(io_error("content document name is unsafe"));
    }
    Ok(value)
}

/// A `content://` URI in the shape `DocumentsContract` gives it: authority plus decoded path
/// segments.
struct ContentUri {
    value: String,
    authority: String,
    segments: Vec<String>,
}

impl ContentUri {
    fn parse(target: &FileTarget) -> Result<Self, DomainError> {
        let value = &target.value;
        let rest = value
            .strip_prefix("content://")
            .filter(|_| target.target_type == FileTargetType::ContentUri)
            .filter(|_| value.len() <= MAX_URI_BYTES && !value.contains('\0'))
            .ok_or_else(|| DomainError::invalid("target is not a bounded content URI"))?;
        let rest = rest.split(['?', '#']).next().unwrap_or_default();
        let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
        if authority.is_empty() {
            return Err(DomainError::invalid("content URI has no authority"));
        }
        let segments = path
            .split('/')
            .filter(|segment| !segment.is_empty())
            .map(percent_decode)
            .collect::<Result<_, _>>()?;
        Ok(Self {
            value: value.clone(),
            authority: authority.to_owned(),
            segments,
        })
    }

    fn is_tree(&self) -> bool {
        self.segments.len() >= 2 && self.segments[0] == "tree"
    }

    fn is_document(&self) -> bool {
        self.segments.len() == 2 && self.segments[0] == "document"
    }

    /// `DocumentsContract.getDocumentId`, falling back to the tree's own document.
    fn tree_document_id(&self) -> Result<String, DomainError> {
        match self.segments.as_slice() {
            [tree, _, document, id, ..] if tree == "tree" && document == "document" => {
                Ok(id.clone())
            }
            [tree, id, ..] if tree == "tree" => Ok(id.clone()),
            _ => Err(DomainError::invalid("content URI is not a document tree")),
        }
    }

    fn tree_document_uri(&self) -> Result<String, DomainError> {
        Ok(format!(
            "content://{}/tree/{}/document/{}",
            self.authority,
            percent_encode(&self.segments[1]),
            percent_encode(&self.tree_document_id()?)
        ))
    }

    fn children_uri(&self, document_id: &str) -> Result<String, DomainError> {
        if !self.is_tree() {
            return Err(DomainError::invalid("content URI is not a document tree"));
        }
        Ok(format!(
            "content://{}/tree/{}/document/{}/children",
            self.authority,
            percent_encode(&self.segments[1]),
            percent_encode(document_id)
        ))
    }
}

/// `android.net.Uri.encode`: everything but letters, digits and `_-!.~'()*` is escaped.
fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"_-!.~'()*".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn percent_decode(value: &str) -> Result<String, DomainError> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let pair = bytes
                .get(index + 1..index + 3)
                .and_then(|pair| std::str::from_utf8(pair).ok())
                .and_then(|pair| u8::from_str_radix(pair, 16).ok())
                .ok_or_else(|| DomainError::invalid("content URI has an invalid escape"))?;
            decoded.push(pair);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| DomainError::invalid("content URI is not UTF-8"))
}

fn not_found() -> DomainError {
    DomainError::new(ErrorCode::NotFound, "content provider returned no row")
}

const fn io_error(reason: &'static str) -> DomainError {
    DomainError::new(ErrorCode::IoError, reason)
}

#[cfg(test)]
mod tests {
    use super::{ContentUri, DOCUMENT_COLUMNS, parse_rows, percent_encode, provider_verdict};
    use contract::{ErrorCode, FileTarget, FileTargetType};

    fn uri(value: &str) -> ContentUri {
        ContentUri::parse(&FileTarget {
            target_type: FileTargetType::ContentUri,
            value: value.to_owned(),
        })
        .unwrap()
    }

    #[test]
    fn rows_split_only_at_their_projection_boundaries() {
        let output = b"Row: 0 mime_type=text/plain, _size=12, last_modified=NULL, document_id=primary:a, b=c, _display_name=a, b=c\nRow: 1 mime_type=vnd.android.document/directory, _size=NULL, last_modified=1700000000000, document_id=primary:d, _display_name=two\nlines\n";
        let rows = parse_rows(output, &DOCUMENT_COLUMNS).unwrap();
        assert_eq!(
            rows[0],
            vec![
                Some("text/plain".to_owned()),
                Some("12".to_owned()),
                None,
                Some("primary:a, b=c".to_owned()),
                Some("a, b=c".to_owned()),
            ]
        );
        assert_eq!(rows[1][4].as_deref(), Some("two\nlines"));
        assert!(
            parse_rows(b"No result found.\n", &DOCUMENT_COLUMNS)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn an_ambiguous_row_is_refused() {
        let output = b"Row: 0 mime_type=x, _size=1, last_modified=2, document_id=a, _display_name=b, _display_name=c\n";
        assert_eq!(
            parse_rows(output, &DOCUMENT_COLUMNS).unwrap_err().code,
            ErrorCode::IoError
        );
    }

    #[test]
    fn provider_failures_keep_their_meaning() {
        assert!(provider_verdict(b"").is_ok());
        let missing = provider_verdict(
            b"Error while accessing provider:media\njava.io.FileNotFoundException: No item\n",
        )
        .unwrap_err();
        assert_eq!(missing.code, ErrorCode::NotFound);
        assert_eq!(
            missing.peer_reason.as_deref(),
            Some("java.io.FileNotFoundException: No item")
        );
        assert_eq!(
            provider_verdict(b"java.lang.SecurityException: denied")
                .unwrap_err()
                .code,
            ErrorCode::PermissionDenied
        );
    }

    #[test]
    fn tree_uris_follow_documents_contract() {
        let tree = uri("content://com.android.externalstorage.documents/tree/primary%3ADownload");
        assert!(tree.is_tree());
        assert_eq!(tree.tree_document_id().unwrap(), "primary:Download");
        assert_eq!(
            tree.children_uri("primary:Download/a b").unwrap(),
            "content://com.android.externalstorage.documents/tree/primary%3ADownload/document/primary%3ADownload%2Fa%20b/children"
        );
        assert!(!uri("content://media/external/images/media/12").is_tree());
        assert_eq!(percent_encode("a~b(c)"), "a~b(c)");
    }
}
