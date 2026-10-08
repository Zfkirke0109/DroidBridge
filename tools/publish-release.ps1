param(
    # The public repository's working tree; `export-public.ps1` replaces everything in it but `.git`.
    [Parameter(Mandatory = $true)][string]$PublicClone,
    # Stop after exporting and showing what would be published, without committing or publishing.
    [switch]$DryRun
)
# Publishes the release `check-release.ps1 -Mode signed` produced at this revision: the public tree,
# then the module release (not Latest) and the APK release (Latest), then verifies what users and
# the App now download. Run it only after the signed check passed at HEAD.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

function Pass([string]$assertion) { Write-Output "PASS $assertion" }
function Fail([string]$assertion) { throw "FAIL $assertion" }
function Native([string]$what, [scriptblock]$command) {
    & $command
    if ($LASTEXITCODE -ne 0) { Fail "$what (exit $LASTEXITCODE)" }
}

$config = @{}
Get-Content release-config.properties | ForEach-Object { $key, $value = $_.Split('=', 2); $config[$key] = $value }
$repository = "$($config.github_owner)/$($config.github_repo)"
$version = [regex]::Match((Get-Content -Raw gradle.properties), '(?m)^droidbridgeVersionName=(\S+)').Groups[1].Value
if (-not $version) { Fail 'gradle.properties names the version' }
$apkTag = "apk-v$version"
$moduleTag = "magisk-v$version"
$dist = Join-Path $root "build/release/$version-signed"
$apkDist = Join-Path $dist 'apk'
$moduleDist = Join-Path $dist 'magisk'
$apkFiles = @("droidbridge-$version-arm64-v8a.apk", 'release.json', 'release.json.sig', 'THIRD_PARTY_NOTICES.txt', 'SHA256SUMS.txt')
$moduleFiles = @("droidbridge-magisk-$version.zip", 'THIRD_PARTY_NOTICES.txt', 'SHA256SUMS.txt')

# 1. The signed artifacts are this revision's, complete and still verifiable.
$revision = (git rev-parse HEAD).Trim()
if (git status --porcelain --untracked-files=no) { Fail 'working tree is clean' }
foreach ($name in $apkFiles) { if (-not (Test-Path (Join-Path $apkDist $name))) { Fail "$apkDist has $name" } }
foreach ($name in $moduleFiles) { if (-not (Test-Path (Join-Path $moduleDist $name))) { Fail "$moduleDist has $name" } }
$manifest = Get-Content -Raw (Join-Path $apkDist 'release.json') | ConvertFrom-Json
if ($manifest.provenance.source_revision -ne $revision) {
    Fail "the signed release was built at HEAD ($($manifest.provenance.source_revision) vs $revision); rerun check-release -Mode signed"
}
Native 'verify-release' { java tools/ReleaseTool.java verify-release $apkDist $version signed | Out-Null }
Native 'verify-module' { java tools/ReleaseTool.java verify-module $moduleDist $version | Out-Null }
Pass "signed $version artifacts belong to $revision and verify"

# 2. Nothing of this version is published yet.
foreach ($tag in $apkTag, $moduleTag) {
    gh release view $tag --repo $repository *> $null
    if ($LASTEXITCODE -eq 0) { Fail "$tag is not yet released" }
}
Pass "$apkTag and $moduleTag are unreleased"

# 3. Release notes: the bilingual CHANGELOG entry under a line naming each release's artifact.
$changelog = (Get-Content -Raw CHANGELOG.md).Replace("`r", '')
$entry = [regex]::Match($changelog, "(?ms)^## $([regex]::Escape($version))\n(.*?)(?=^## |\z)")
if (-not $entry.Success) { Fail "CHANGELOG.md has a $version entry" }
$body = $entry.Groups[1].Value.Trim()
$releases = "https://github.com/$repository/releases/tag"
$notes = Join-Path $dist 'notes'
New-Item -ItemType Directory -Force $notes | Out-Null
$apkNotes = Join-Path $notes 'apk.md'
$moduleNotes = Join-Path $notes 'magisk.md'
[IO.File]::WriteAllText($apkNotes, @"
**DroidBridge $version, the App for phones without root.** Install ``droidbridge-$version-arm64-v8a.apk``. For the root edition, see [``$moduleTag``]($releases/$moduleTag).

**卓爱桥 $version，面向未 Root 手机的 App。** 安装 ``droidbridge-$version-arm64-v8a.apk``。Root 版请见 [``$moduleTag``]($releases/$moduleTag)。

$body
"@.Replace("`r", ''), [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($moduleNotes, @"
**DroidBridge root edition $version.** Install ``droidbridge-magisk-$version.zip`` in Magisk, KernelSU or APatch; it also installs the DroidBridge Root app. Reboot afterwards. For phones without root, see [``$apkTag``]($releases/$apkTag).

**卓爱桥 Root 版 $version。** 在 Magisk、KernelSU 或 APatch 中安装 ``droidbridge-magisk-$version.zip``，会一并安装 DroidBridge Root App，安装后重启手机。未 Root 的手机请见 [``$apkTag``]($releases/$apkTag)。

$body
"@.Replace("`r", ''), [Text.UTF8Encoding]::new($false))
Pass "release notes written to $notes"

# 4. The public tree.
Native 'export-public' { pwsh -NoProfile -File tools/export-public.ps1 -Destination $PublicClone }
if ($DryRun) {
    git -C $PublicClone status --short | Select-Object -First 40
    Write-Output "DRY RUN: nothing committed or published. Review $PublicClone and $notes, then reset the clone with: git -C `"$PublicClone`" reset --hard; git -C `"$PublicClone`" clean -fd"
    return
}
Native 'public commit' { git -C $PublicClone add -A }
Native 'public commit' { git -C $PublicClone commit -q -m "DroidBridge $version" -m "See CHANGELOG.md for what changed." }
Native 'public push' { git -C $PublicClone push -q origin HEAD:main }
$publicRevision = (git -C $PublicClone rev-parse HEAD).Trim()
Pass "public tree $publicRevision pushed"

# 5. The module release first, so the updateJson now on main never names a missing ZIP for long;
#    the APK release last and Latest, because the App reads releases/latest/download/release.json.
Native "create $moduleTag" {
    gh release create $moduleTag --repo $repository --target $publicRevision --title "DroidBridge Root $version" `
        --notes-file $moduleNotes --latest=false @($moduleFiles | ForEach-Object { Join-Path $moduleDist $_ })
}
Native "create $apkTag" {
    gh release create $apkTag --repo $repository --target $publicRevision --title "DroidBridge $version" `
        --notes-file $apkNotes --latest @($apkFiles | ForEach-Object { Join-Path $apkDist $_ })
}

# 6. What users and the App download is exactly what was verified.
$check = Join-Path $dist 'published'
if (Test-Path $check) { Remove-Item -Recurse -Force $check }
New-Item -ItemType Directory -Force (Join-Path $check 'apk'), (Join-Path $check 'magisk') | Out-Null
Native "download $apkTag" { gh release download $apkTag --repo $repository --dir (Join-Path $check 'apk') }
Native "download $moduleTag" { gh release download $moduleTag --repo $repository --dir (Join-Path $check 'magisk') }
foreach ($pair in @(@($apkDist, 'apk', $apkFiles), @($moduleDist, 'magisk', $moduleFiles))) {
    $source, $folder, $names = $pair
    foreach ($name in $names) {
        if ((Get-FileHash (Join-Path $source $name)).Hash -ne (Get-FileHash (Join-Path $check "$folder/$name")).Hash) {
            Fail "published $folder/$name equals the verified artifact"
        }
    }
}
Pass 'every published asset equals the verified artifact'
$latest = Join-Path $check 'latest-release.json'
Invoke-WebRequest -UseBasicParsing -OutFile $latest "https://github.com/$repository/releases/latest/download/release.json"
if ((Get-FileHash $latest).Hash -ne (Get-FileHash (Join-Path $apkDist 'release.json')).Hash) { Fail 'the App update check reads this release.json' }
Pass 'releases/latest/download/release.json is this release'
# raw.githubusercontent.com caches for a few minutes, so the new updateJson may take a moment.
$update = Join-Path $check 'update.json'
$deadline = (Get-Date).AddMinutes(6)
do {
    Invoke-WebRequest -UseBasicParsing -OutFile $update -Headers @{ 'Cache-Control' = 'no-cache' } `
        "https://raw.githubusercontent.com/$repository/main/magisk/update.json"
    $served = (Get-FileHash $update).Hash -eq (Get-FileHash magisk/update.json).Hash
    if (-not $served) { Start-Sleep -Seconds 20 }
} until ($served -or (Get-Date) -gt $deadline)
if (-not $served) { Fail 'magisk/update.json on main is this release' }
$zip = Join-Path $check 'update-zip.zip'
Invoke-WebRequest -UseBasicParsing -OutFile $zip ((Get-Content -Raw $update | ConvertFrom-Json).zipUrl)
if ((Get-FileHash $zip).Hash -ne (Get-FileHash (Join-Path $moduleDist "droidbridge-magisk-$version.zip")).Hash) {
    Fail 'the updateJson zipUrl serves this module'
}
Pass 'Magisk updateJson offers this module'
Write-Output "RESULT PASS publish-release ${version}: $releases/$apkTag (Latest), $releases/$moduleTag, public $publicRevision"
