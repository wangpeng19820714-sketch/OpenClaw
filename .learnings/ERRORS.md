# Errors Log

Command failures, exceptions, and unexpected behaviors.

---

- 2026-03-26: A sandboxed localhost bind probe produced a false `gateway bind=custom requested 127.0.0.1 but resolved 0.0.0.0; refusing fallback` conclusion while testing repo-local notifier drain startup. Re-running the same probe outside the sandbox and starting the repo-local gateway from source with `OPENCLAW_CONFIG_PATH=configs/openclaw.json OPENCLAW_NO_RESPAWN=1 node --import tsx src/entry.ts gateway --port 18790` succeeded. Treat bind/listen failures from sandboxed `net.createServer()` probes as environment artifacts until they are reproduced outside the sandbox.
