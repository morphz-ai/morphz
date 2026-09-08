// A one-use, short-lived grant for the trusted main frame. Never applies to websites.
class MicrophoneGate {
  constructor(origin, now = Date.now) {
    this.origin = origin;
    this.now = now;
    this.until = 0;
  }
  arm() {
    this.until = this.now() + 15000;
  }
  cancel() {
    this.until = 0;
  }
  request(trusted, permission, details) {
    let origin;
    try {
      origin = new URL(details?.requestingUrl).origin;
    } catch {
      return false;
    }
    if (
      !trusted ||
      permission !== "media" ||
      !details.isMainFrame ||
      origin !== this.origin ||
      this.now() >= this.until ||
      details.mediaTypes?.length !== 1 ||
      details.mediaTypes[0] !== "audio"
    )
      return false;
    this.cancel();
    return true;
  }
}
module.exports = { MicrophoneGate };
