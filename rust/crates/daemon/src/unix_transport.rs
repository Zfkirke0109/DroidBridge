use crate::MAX_FRAME_BYTES;
use contract::ErrorCode;
use domain::DomainError;
use serde::{Serialize, de::DeserializeOwned};
use std::{
    io::{Read, Write},
    mem::{offset_of, size_of},
    os::fd::{AsRawFd, FromRawFd},
    os::unix::net::UnixStream,
};

pub fn connect_abstract(name: &str) -> std::io::Result<UnixStream> {
    if name.is_empty()
        || name.len() + 1 > size_of::<libc::sockaddr_un>() - offset_of!(libc::sockaddr_un, sun_path)
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid abstract socket name",
        ));
    }
    let descriptor =
        unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if descriptor < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (target, source) in address.sun_path[1..].iter_mut().zip(name.as_bytes()) {
        *target = *source as libc::c_char;
    }
    let address_length =
        (offset_of!(libc::sockaddr_un, sun_path) + 1 + name.len()) as libc::socklen_t;
    let result = unsafe {
        libc::connect(
            descriptor,
            std::ptr::addr_of!(address).cast(),
            address_length,
        )
    };
    if result != 0 {
        let error = std::io::Error::last_os_error();
        unsafe { libc::close(descriptor) };
        return Err(error);
    }
    Ok(unsafe { UnixStream::from_raw_fd(descriptor) })
}

pub fn peer_uid(stream: &UnixStream) -> std::io::Result<u32> {
    let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
    let mut length = size_of::<libc::ucred>() as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            std::ptr::addr_of_mut!(credentials).cast(),
            &mut length,
        )
    };
    if result != 0 || length as usize != size_of::<libc::ucred>() {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(credentials.uid)
    }
}

pub fn send_json<T: Serialize>(stream: &mut UnixStream, value: &T) -> Result<(), DomainError> {
    let body = serde_json::to_vec(value)
        .map_err(|_| DomainError::new(ErrorCode::InternalError, "IPC JSON encoding failed"))?;
    send_body(stream, &body)
}

pub fn receive_json<T: DeserializeOwned>(stream: &mut UnixStream) -> Result<T, DomainError> {
    let body = receive_body(stream)?;
    serde_json::from_slice(&body).map_err(|_| protocol_error("invalid IPC JSON"))
}

fn send_body(stream: &mut UnixStream, body: &[u8]) -> Result<(), DomainError> {
    if body.is_empty() || body.len() > MAX_FRAME_BYTES {
        return Err(DomainError::new(
            ErrorCode::ResourceLimit,
            "IPC frame exceeds its bound",
        ));
    }
    let header = u32::try_from(body.len())
        .map_err(|_| DomainError::new(ErrorCode::ResourceLimit, "IPC frame length overflow"))?
        .to_be_bytes();
    stream.write_all(&header).map_err(io_error)?;
    stream.write_all(body).map_err(io_error)
}

fn receive_body(stream: &mut UnixStream) -> Result<Vec<u8>, DomainError> {
    let mut header = [0_u8; 4];
    stream.read_exact(&mut header).map_err(|error| {
        if error.kind() == std::io::ErrorKind::UnexpectedEof {
            DomainError::new(ErrorCode::IoError, "IPC peer disconnected")
        } else {
            io_error(error)
        }
    })?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(protocol_error("invalid IPC frame length"));
    }
    let mut body = vec![0_u8; length];
    stream.read_exact(&mut body).map_err(io_error)?;
    std::str::from_utf8(&body).map_err(|_| protocol_error("IPC JSON is not UTF-8"))?;
    Ok(body)
}

fn protocol_error(reason: &'static str) -> DomainError {
    DomainError::new(ErrorCode::ProtocolIncompatible, reason)
}

fn io_error(error: std::io::Error) -> DomainError {
    DomainError::os(ErrorCode::IoError, "daemon IPC I/O failed", &error)
}
