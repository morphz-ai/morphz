//! Opt-in hosted admission gate. No model/tool can enable parking or bypass it.
use axum::{body::Body, extract::Request, middleware::Next, response::Response, Extension};
use std::{
    collections::HashMap,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    task::{Context, Poll},
    time::{Duration, Instant},
};

pub const RESERVATION_HEADER: &str = "x-morphz-host-reservation";
pub const RESERVATION_PATH: &str = "/_morphz/host/admission";
pub const RESERVATION_TTL_MS: u64 = 30_000;
const MAX_RESERVATIONS: usize = 64;

struct State {
    requests: usize,
    parking: bool,
    last_activity: Instant,
    reservations: HashMap<String, Instant>,
}
pub struct HostRequestGate {
    state: Mutex<State>,
    parking_changed: tokio::sync::Notify,
}
impl Default for HostRequestGate {
    fn default() -> Self {
        Self {
            state: Mutex::new(State {
                requests: 0,
                parking: false,
                last_activity: Instant::now(),
                reservations: HashMap::new(),
            }),
            parking_changed: tokio::sync::Notify::new(),
        }
    }
}
pub struct RequestPermit {
    gate: Arc<HostRequestGate>,
    activity: bool,
    active: AtomicBool,
}
pub struct ParkAttempt {
    gate: Arc<HostRequestGate>,
    committed: bool,
}
impl HostRequestGate {
    /// An authenticated gateway reserves before sending a business body. This
    /// is process-local admission, not acceptance of any user message or effect.
    /// Lost gateway requests expire; they never become durable phantom work.
    pub fn reserve(&self) -> Result<Option<String>, &'static str> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        state.reservations.retain(|_, expires| *expires > now);
        if state.parking || state.reservations.len() >= MAX_RESERVATIONS {
            return Ok(None);
        }
        let mut bytes = [0_u8; 32];
        getrandom::fill(&mut bytes).map_err(|_| "host admission entropy unavailable")?;
        let id = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        state
            .reservations
            .insert(id.clone(), now + Duration::from_millis(RESERVATION_TTL_MS));
        state.last_activity = now;
        Ok(Some(id))
    }
    pub fn enter_reserved(self: &Arc<Self>, id: &str) -> Option<RequestPermit> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let expires = state.reservations.remove(id)?;
        if state.parking || expires <= Instant::now() {
            return None;
        }
        state.requests += 1;
        state.last_activity = Instant::now();
        Some(RequestPermit {
            gate: self.clone(),
            activity: true,
            active: AtomicBool::new(true),
        })
    }
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
            active: AtomicBool::new(true),
        })
    }
    pub fn begin_park(self: &Arc<Self>, idle: Duration) -> Option<ParkAttempt> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        state.reservations.retain(|_, expires| *expires > now);
        if state.parking
            || state.requests != 0
            || !state.reservations.is_empty()
            || state.last_activity.elapsed() < idle
        {
            return None;
        }
        state.parking = true;
        self.parking_changed.notify_waiters();
        Some(ParkAttempt {
            gate: self.clone(),
            committed: false,
        })
    }
    async fn wait_for_parking(&self) {
        let changed = self.parking_changed.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        if self.state.lock().unwrap_or_else(|e| e.into_inner()).parking {
            return;
        }
        changed.await;
    }
}
impl RequestPermit {
    /// Only an authenticated Edge claim that has returned no work may yield
    /// its admission while waiting. Re-entry is mandatory before another claim.
    pub fn pause_empty_edge_poll(&self) -> bool {
        // A gateway business reservation is a stronger pin, never downgrade it.
        if self.activity {
            return false;
        }
        let mut state = self.gate.state.lock().unwrap_or_else(|e| e.into_inner());
        if self.active.swap(false, Ordering::Relaxed) {
            state.requests -= 1;
        }
        true
    }
    pub fn resume_edge_poll(&self) -> bool {
        let mut state = self.gate.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.parking {
            return false;
        }
        if !self.active.swap(true, Ordering::Relaxed) {
            state.requests += 1;
        }
        true
    }
    pub async fn wait_for_parking(&self) {
        self.gate.wait_for_parking().await;
    }
}
impl Drop for RequestPermit {
    fn drop(&mut self) {
        let mut state = self.gate.state.lock().unwrap_or_else(|e| e.into_inner());
        if self.active.load(Ordering::Relaxed) {
            state.requests -= 1;
        }
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
    permit: Option<Arc<RequestPermit>>,
}

/// Idle maintenance does not renew the business activity clock. Authentication
/// and every actual Store operation still run under normal native admission.
pub fn is_passive_edge_request(method: &str, path: &str) -> bool {
    if method != "POST" {
        return false;
    }
    let Some(rest) = path.strip_prefix("/api/edge/nodes/") else {
        return false;
    };
    let Some((node, operation)) = rest.split_once('/') else {
        return false;
    };
    !node.is_empty()
        && node.len() <= 200
        && node
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
        && matches!(
            operation,
            "challenge" | "connect" | "heartbeat" | "jobs/claim"
        )
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
    mut request: Request,
    next: Next,
) -> Response {
    // Health probes participate in admission, but do not keep idle compute warm.
    let permit = match request.headers().get(RESERVATION_HEADER) {
        Some(id) => match id.to_str().ok().and_then(|id| gate.enter_reserved(id)) {
            Some(permit) => Some(permit),
            None => {
                return Response::builder()
                    .status(409)
                    .header("content-type", "application/json")
                    .header("cache-control", "no-store")
                    .body(Body::from(
                        r#"{"error":"host_admission_expired","admission":"not_accepted"}"#,
                    ))
                    .expect("static response")
            }
        },
        None => gate.enter(
            request.uri().path() != "/health"
                && !is_passive_edge_request(request.method().as_str(), request.uri().path()),
        ),
    };
    let Some(permit) = permit else {
        return parking_response();
    };
    let permit = Arc::new(permit);
    request.extensions_mut().insert(permit.clone());
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
    #[tokio::test]
    async fn empty_poll_yields_but_claim_reentry_and_parking_are_exclusive() {
        let gate = Arc::new(HostRequestGate::default());
        let poll = gate.enter(false).unwrap();
        assert!(gate.begin_park(Duration::ZERO).is_none());
        assert!(poll.pause_empty_edge_poll());
        assert!(poll.pause_empty_edge_poll()); // no request-count underflow
        assert!(poll.resume_edge_poll());
        assert!(gate.begin_park(Duration::ZERO).is_none());
        assert!(poll.pause_empty_edge_poll());
        let park = gate.begin_park(Duration::ZERO).unwrap();
        tokio::time::timeout(Duration::from_secs(1), poll.wait_for_parking())
            .await
            .unwrap();
        assert!(!poll.resume_edge_poll());
        drop(park);
        assert!(poll.resume_edge_poll());
        drop(poll);
        assert!(gate.begin_park(Duration::ZERO).is_some());
    }
    #[test]
    fn passive_poll_does_not_renew_activity_or_weaken_a_business_reservation() {
        let gate = Arc::new(HostRequestGate::default());
        gate.state.lock().unwrap().last_activity = Instant::now() - Duration::from_secs(60);
        let poll = gate.enter(false).unwrap();
        assert!(poll.pause_empty_edge_poll());
        drop(poll);
        assert!(gate.begin_park(Duration::from_secs(30)).is_some());
        let id = gate.reserve().unwrap().unwrap();
        let business = gate.enter_reserved(&id).unwrap();
        assert!(!business.pause_empty_edge_poll());
        assert!(gate.begin_park(Duration::ZERO).is_none());
    }
    #[test]
    fn only_closed_idle_edge_routes_are_passive() {
        for operation in ["challenge", "connect", "heartbeat", "jobs/claim"] {
            assert!(is_passive_edge_request(
                "POST",
                &format!("/api/edge/nodes/node-1_2/{operation}")
            ));
        }
        for path in [
            "/api/edge/pair",
            "/api/edge/nodes/n/jobs/j/heartbeat",
            "/api/edge/nodes/n/jobs/j/finish",
            "/api/edge/nodes/n/rotate-key",
            "/api/edge/nodes/n/heartbeat/",
            "/api/edge/nodes/n%2Fx/heartbeat",
            "/api/edge/nodes//heartbeat",
        ] {
            assert!(!is_passive_edge_request("POST", path));
        }
        assert!(!is_passive_edge_request(
            "GET",
            "/api/edge/nodes/n/heartbeat"
        ));
    }
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
    #[test]
    fn reservation_pins_compute_until_consumed_and_is_not_a_reusable_permission() {
        let gate = Arc::new(HostRequestGate::default());
        let id = gate.reserve().unwrap().unwrap();
        assert!(gate.begin_park(Duration::ZERO).is_none());
        assert!(gate.enter_reserved("invented").is_none());
        let permit = gate.enter_reserved(&id).unwrap();
        assert!(gate.enter_reserved(&id).is_none());
        assert!(gate.begin_park(Duration::ZERO).is_none());
        drop(permit);
        let park = gate.begin_park(Duration::ZERO).unwrap();
        assert!(gate.reserve().unwrap().is_none());
        drop(park);
    }
    #[test]
    fn lost_reservations_are_bounded_and_expire_without_a_timer_or_durable_work() {
        let gate = Arc::new(HostRequestGate::default());
        for _ in 0..MAX_RESERVATIONS {
            assert!(gate.reserve().unwrap().is_some());
        }
        assert!(gate.reserve().unwrap().is_none());
        let old = {
            let mut state = gate.state.lock().unwrap();
            for expires in state.reservations.values_mut() {
                *expires = Instant::now() - Duration::from_secs(1);
            }
            state.reservations.keys().next().unwrap().clone()
        };
        assert!(gate.enter_reserved(&old).is_none());
        assert!(gate.begin_park(Duration::ZERO).is_some());
        assert!(gate.reserve().unwrap().is_some());
    }
    #[tokio::test]
    async fn response_body_holds_admission_until_drained_or_disconnected() {
        let gate = Arc::new(HostRequestGate::default());
        let body = Body::new(GuardedBody {
            body: Body::from("response"),
            permit: gate.enter(true).map(Arc::new),
        });
        assert!(gate.begin_park(Duration::ZERO).is_none());
        assert_eq!(axum::body::to_bytes(body, 100).await.unwrap(), "response");
        drop(gate.begin_park(Duration::ZERO).unwrap());
        let body = Body::new(GuardedBody {
            body: Body::from("response"),
            permit: gate.enter(true).map(Arc::new),
        });
        drop(body);
        assert!(gate.begin_park(Duration::ZERO).is_some());
    }
}
