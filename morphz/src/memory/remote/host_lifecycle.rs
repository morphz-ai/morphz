//! Opt-in hosted admission gate. No model/tool can enable parking or bypass it.
use axum::{body::Body, extract::Request, middleware::Next, response::Response, Extension};
use std::{
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::{Duration, Instant},
};

struct State {
    requests: usize,
    parking: bool,
    last_activity: Instant,
}
pub struct HostRequestGate {
    state: Mutex<State>,
}
impl Default for HostRequestGate {
    fn default() -> Self {
        Self {
            state: Mutex::new(State {
                requests: 0,
                parking: false,
                last_activity: Instant::now(),
            }),
        }
    }
}
pub struct RequestPermit {
    gate: Arc<HostRequestGate>,
    activity: bool,
}
pub struct ParkAttempt {
    gate: Arc<HostRequestGate>,
    committed: bool,
}
impl HostRequestGate {
    pub fn enter(self: &Arc<Self>, activity: bool) -> Option<RequestPermit> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.parking {
            return None;
        }
        state.requests += 1;
        if activity {
            state.last_activity = Instant::now();
        }
        Some(RequestPermit {
            gate: self.clone(),
            activity,
        })
    }
    pub fn begin_park(self: &Arc<Self>, idle: Duration) -> Option<ParkAttempt> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.parking || state.requests != 0 || state.last_activity.elapsed() < idle {
            return None;
        }
        state.parking = true;
        Some(ParkAttempt {
            gate: self.clone(),
            committed: false,
        })
    }
}
impl Drop for RequestPermit {
    fn drop(&mut self) {
        let mut state = self.gate.state.lock().unwrap_or_else(|e| e.into_inner());
        state.requests -= 1;
        if self.activity {
            state.last_activity = Instant::now();
        }
    }
}
impl ParkAttempt {
    /// Commit only after the authoritative Cell confirms parking. Admission
    /// stays closed until process exit; it must not reopen with an old fence.
    pub fn commit(mut self) {
        self.committed = true;
    }
}
impl Drop for ParkAttempt {
    fn drop(&mut self) {
        if !self.committed {
            self.gate
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .parking = false;
        }
    }
}
pub fn parking_response() -> Response {
    Response::builder()
        .status(503)
        .header("retry-after", "1")
        .header("content-type", "application/json")
        .header("cache-control", "no-store")
        .body(Body::from(
            r#"{"error":"runtime_parking","retryable":true}"#,
        ))
        .expect("static response")
}
struct GuardedBody {
    body: Body,
    permit: Option<RequestPermit>,
}
impl http_body::Body for GuardedBody {
    type Data = axum::body::Bytes;
    type Error = axum::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        let result = Pin::new(&mut self.body).poll_frame(cx);
        if matches!(&result, Poll::Ready(None | Some(Err(_)))) {
            self.permit.take();
        }
        result
    }
    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }
    fn size_hint(&self) -> http_body::SizeHint {
        self.body.size_hint()
    }
}
pub async fn gate_request(
    Extension(gate): Extension<Arc<HostRequestGate>>,
    request: Request,
    next: Next,
) -> Response {
    // Health probes participate in admission, but do not keep idle compute warm.
    let Some(permit) = gate.enter(request.uri().path() != "/health") else {
        return parking_response();
    };
    let (parts, body) = next.run(request).await.into_parts();
    Response::from_parts(
        parts,
        Body::new(GuardedBody {
            body,
            permit: Some(permit),
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn admission_and_parking_are_mutually_exclusive_and_failed_checks_reopen() {
        let gate = Arc::new(HostRequestGate::default());
        let request = gate.enter(true).unwrap();
        assert!(gate.begin_park(Duration::ZERO).is_none());
        drop(request);
        assert!(gate.begin_park(Duration::from_secs(1)).is_none());
        let attempt = gate.begin_park(Duration::ZERO).unwrap();
        assert!(gate.enter(false).is_none());
        drop(attempt);
        drop(gate.enter(false).unwrap());
        gate.begin_park(Duration::ZERO).unwrap().commit();
        assert!(gate.enter(true).is_none());
    }
    #[tokio::test]
    async fn response_body_holds_admission_until_drained_or_disconnected() {
        let gate = Arc::new(HostRequestGate::default());
        let body = Body::new(GuardedBody {
            body: Body::from("response"),
            permit: gate.enter(true),
        });
        assert!(gate.begin_park(Duration::ZERO).is_none());
        assert_eq!(axum::body::to_bytes(body, 100).await.unwrap(), "response");
        drop(gate.begin_park(Duration::ZERO).unwrap());
        let body = Body::new(GuardedBody {
            body: Body::from("response"),
            permit: gate.enter(true),
        });
        drop(body);
        assert!(gate.begin_park(Duration::ZERO).is_some());
    }
}
