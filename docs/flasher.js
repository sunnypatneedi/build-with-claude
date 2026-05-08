// Claudachi installer — post-flash apps push.
//
// ESP Web Tools handles the firmware-flash phase as a self-contained
// black box. Once it finishes and the device reboots into UIFlow, the
// user clicks "Install apps" and *this* code:
//
//   1. opens a fresh WebSerial port (user re-picks via browser picker)
//   2. interrupts whatever's running with a few Ctrl-C bytes
//   3. ensures /flash/apps/ exists, sets NVS boot_option=2
//   4. paste-mode-uploads each .py from bundle/ to its /flash/ destination
//      using the same 512-byte base64-chunk protocol m5-onboard uses
//   5. soft-reboots so the device comes up running our main.py launcher
//
// We intentionally don't use ESP Web Tools' improv-wifi or console
// hooks — they're scoped to the firmware-flash phase and don't
// give us the post-flash REPL access we need. All of step 2-5 happens
// over plain WebSerial in user-gesture context.

(function () {
  "use strict";

  const TEXT_DECODER = new TextDecoder();
  const TEXT_ENCODER = new TextEncoder();

  // Mirrors install_apps.py:_CHUNK_BYTES. Smaller blocks were observed
  // truncating on the device-RX side; 512 is the sweet spot.
  const CHUNK_BYTES = 512;
  const BAUD = 115200;

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function bytesToB64(bytes) {
    // String.fromCharCode + btoa works for byte values 0–255. Our
    // chunks are <=512 bytes so we don't risk the call-stack issue
    // that bites larger conversions.
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  // Thin wrapper around a WebSerial port that buffers RX into a string
  // and exposes paste-mode REPL exec on TX. Models mpy_repl.py.
  class ReplLink {
    constructor(port) {
      this.port = port;
      this.reader = port.readable.getReader();
      this.writer = port.writable.getWriter();
      this.buf = "";
      this._closed = false;
      this._readLoop();
    }

    async _readLoop() {
      try {
        while (!this._closed) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value) this.buf += TEXT_DECODER.decode(value);
        }
      } catch (e) {
        // reader closed or device went away — fine
      }
    }

    async send(bytesOrStr) {
      const data =
        typeof bytesOrStr === "string"
          ? TEXT_ENCODER.encode(bytesOrStr)
          : bytesOrStr;
      await this.writer.write(data);
    }

    async drain(ms = 200) {
      await sleep(ms);
      const out = this.buf;
      this.buf = "";
      return out;
    }

    // Send Ctrl-C repeatedly to break out of any running script and
    // land at the >>> prompt. Mirrors mpy_repl.interrupt_to_repl.
    async interrupt() {
      for (let i = 0; i < 5; i++) {
        await this.send(new Uint8Array([0x03])); // Ctrl-C
        await sleep(60);
      }
      await this.send("\r\n");
      await this.drain(400);
    }

    // Paste-mode exec, modeled on mpy_repl.paste_exec. We bracket
    // the user script with a sentinel `print` and strip everything
    // up to and including the second occurrence (the first is the
    // echoed source line; the second is its actual output).
    async pasteExec(script, settle = 200) {
      const sentinel = "__CC_DONE__";
      const body = `print("${sentinel}")\n${script}`;

      // Drop any pending RX before we start.
      this.buf = "";

      // Enter paste mode (Ctrl-E).
      await this.send(new Uint8Array([0x05]));
      await sleep(80);
      this.buf = "";

      // Send body line by line; paste-mode echoes each line.
      for (const line of body.split("\n")) {
        await this.send(line + "\r\n");
        // Tiny inter-line sleep — without it some lines coalesce on
        // the device's RX and the line buffer overflows.
        await sleep(4);
      }

      // Execute (Ctrl-D).
      await this.send(new Uint8Array([0x04]));
      await sleep(settle);

      const raw = this.buf;
      this.buf = "";

      // Strip everything up to and including the SECOND sentinel.
      let idx = 0;
      for (let i = 0; i < 2; i++) {
        const found = raw.indexOf(sentinel, idx);
        if (found < 0) break;
        const nl = raw.indexOf("\n", found);
        idx = nl >= 0 ? nl + 1 : found + sentinel.length;
      }
      const out = raw.slice(idx);

      if (out.includes("Traceback")) {
        throw new Error("device-side error:\n" + out);
      }
      return out;
    }

    async close() {
      this._closed = true;
      try { this.reader.cancel(); } catch (e) {}
      try { this.reader.releaseLock(); } catch (e) {}
      try { this.writer.releaseLock(); } catch (e) {}
      try { await this.port.close(); } catch (e) {}
    }
  }

  async function ensureDir(repl, path) {
    // OSError(17) is EEXIST — directory already there is fine; any
    // other errno is a real failure and should propagate.
    const script = [
      "import os",
      "try:",
      `  os.mkdir(${JSON.stringify(path)})`,
      "except OSError as e:",
      "  if e.args[0] != 17: raise",
      `print("MKDIR", ${JSON.stringify(path)})`,
    ].join("\n");
    const out = await repl.pasteExec(script, 250);
    if (!out.includes(`MKDIR ${path}`)) {
      throw new Error(`mkdir ${path} failed:\n${out}`);
    }
  }

  // Mirrors install_apps.py:_set_user_app_boot_mode. Required because
  // bundle ships a root main.py that wants to own the boot flow on
  // ESP32-S3 (Cardputer-Adv) — UIFlow's default boot_option=1
  // wedges the BLE controller before user code runs.
  async function setBootOption2(repl) {
    const script = [
      "import esp32",
      'nvs = esp32.NVS("uiflow")',
      "try: nvs.erase_key('boot_option')",
      "except: pass",
      "nvs.set_u8('boot_option', 2)",
      "nvs.commit()",
      "print('BOOT_OPT', nvs.get_u8('boot_option'))",
    ].join("\n");
    const out = await repl.pasteExec(script, 250);
    if (!out.includes("BOOT_OPT 2")) {
      throw new Error(`boot_option set failed:\n${out}`);
    }
  }

  async function uploadFile(repl, src, dest, onProgress) {
    const resp = await fetch(`bundle/${src}`, { cache: "no-cache" });
    if (!resp.ok) {
      throw new Error(`fetch bundle/${src}: ${resp.status}`);
    }
    const data = new Uint8Array(await resp.arrayBuffer());

    // Open the destination once; paste-mode globals persist across
    // blocks, so `fp` stays open for the chunk-write loop.
    const head =
      "import ubinascii\n" +
      `fp = open(${JSON.stringify(dest)}, "wb")\n`;
    await repl.pasteExec(head, 200);

    let sent = 0;
    while (sent < data.length) {
      const chunk = data.slice(sent, sent + CHUNK_BYTES);
      const b64 = bytesToB64(chunk);
      // One paste block per chunk — same as install_apps.py.
      await repl.pasteExec(
        `fp.write(ubinascii.a2b_base64("${b64}"))\n`,
        50
      );
      sent += chunk.length;
      if (onProgress) onProgress(dest, sent, data.length);
    }

    const tail = `fp.close()\nprint("WROTE", ${JSON.stringify(dest)})\n`;
    const out = await repl.pasteExec(tail, 200);
    if (!out.includes(`WROTE ${dest}`)) {
      throw new Error(`close/verify failed for ${dest}:\n${out}`);
    }
  }

  async function softReboot(repl) {
    // Don't pasteExec — we want to fire-and-forget; the device will
    // reset before any sentinel can come back.
    await repl.send("\r\nimport machine\r\nmachine.reset()\r\n");
  }

  // ----- UI glue ------------------------------------------------------

  function setStatus(line, percent) {
    const status = document.getElementById("apps-status");
    const lineEl = document.getElementById("apps-status-line");
    const prog = document.getElementById("apps-progress");
    status.hidden = false;
    if (line !== undefined) lineEl.textContent = line;
    if (percent !== undefined) prog.value = percent;
  }

  async function runInstall() {
    const btn = document.getElementById("install-apps");
    btn.disabled = true;
    setStatus("Requesting serial port…", 0);

    let port = null;
    try {
      // requestPort fires a user-gesture-required browser picker.
      // The user re-selects the device after the firmware reboot.
      port = await navigator.serial.requestPort({});
      await port.open({ baudRate: BAUD });
    } catch (e) {
      setStatus("Port not selected — click again to retry. " + e.message);
      btn.disabled = false;
      return;
    }

    const repl = new ReplLink(port);
    try {
      setStatus("Interrupting any running app…", 2);
      await repl.interrupt();

      setStatus("Ensuring /flash/apps/ exists…", 4);
      await ensureDir(repl, "/flash/apps");

      setStatus("Setting boot_option=2…", 6);
      await setBootOption2(repl);

      const manifest = await fetch("bundle/files.json", {
        cache: "no-cache",
      }).then((r) => r.json());
      const total = manifest.files.length;
      // Reserve 6% for setup, 90% for files, 4% for reboot.
      const baseAfterSetup = 6;
      const filesBudget = 90;

      for (let i = 0; i < total; i++) {
        const entry = manifest.files[i];
        const fileBase = baseAfterSetup + (i / total) * filesBudget;
        setStatus(`(${i + 1}/${total}) ${entry.dest}`, fileBase);
        await uploadFile(repl, entry.src, entry.dest, (dest, sent, len) => {
          const pct = fileBase + (sent / len) * (filesBudget / total);
          setStatus(`(${i + 1}/${total}) ${dest} — ${sent}/${len} bytes`, pct);
        });
      }

      setStatus("Rebooting device…", 98);
      await softReboot(repl);

      setStatus("Done! Power-cycle and pick claudachi from the menu.", 100);
      btn.textContent = "✓ Installed";

      // Tell progress.js to mark step 4 complete and scroll to step 5.
      // Decoupled via a custom event so flasher.js doesn't need to
      // know anything about the step UI.
      document.dispatchEvent(
        new CustomEvent("claudachi:step-complete", {
          detail: { step: "step-4", nextId: "step-5" },
        })
      );
    } catch (e) {
      console.error(e);
      setStatus("Error: " + (e.message || e));
      btn.disabled = false;
    } finally {
      try { await repl.close(); } catch (e) {}
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("install-apps");
    if (!btn) return;
    if (!("serial" in navigator)) {
      btn.disabled = true;
      btn.textContent = "WebSerial not supported";
      setStatus(
        "Use Chrome, Edge, or Brave on a desktop. WebSerial is not available in this browser."
      );
      return;
    }
    btn.addEventListener("click", runInstall);
  });
})();
