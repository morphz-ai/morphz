use std::fmt;

pub type CoordinationResult<T> = Result<T, CoordinationError>;

#[derive(Debug)]
pub enum CoordinationError {
    InvalidRequest(String),
    Routing(String),
    Transport(String),
    Graph(String),
    Settlement(String),
    Certificate(String),
    Commit(String),
    Serialization(String),
}

impl fmt::Display for CoordinationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (kind, message) = match self {
            Self::InvalidRequest(message) => ("invalid request", message),
            Self::Routing(message) => ("routing failed", message),
            Self::Transport(message) => ("transport failed", message),
            Self::Graph(message) => ("contribution graph is invalid", message),
            Self::Settlement(message) => ("semantic settlement failed", message),
            Self::Certificate(message) => ("commit certificate is invalid", message),
            Self::Commit(message) => ("Union commit failed", message),
            Self::Serialization(message) => ("serialization failed", message),
        };
        write!(formatter, "{kind}: {message}")
    }
}

impl std::error::Error for CoordinationError {}

impl From<serde_json::Error> for CoordinationError {
    fn from(error: serde_json::Error) -> Self {
        Self::Serialization(error.to_string())
    }
}
