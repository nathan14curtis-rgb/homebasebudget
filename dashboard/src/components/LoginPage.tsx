import { useState, type FormEvent } from "react";
import { api, errorMessage } from "../api";
import { formatUsPhoneDisplay, usPhoneToE164 } from "../copy";
import { Notice } from "./Notice";

interface Props {
  onLoggedIn: () => void;
  onCreateHouseholdInstead: () => void;
}

export function LoginPage({ onLoggedIn, onCreateHouseholdInstead }: Props) {
  const [phoneDigits, setPhoneDigits] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A bare 10-digit US number is what people actually type here — the
  // dashboard's own users, not the Sendblue webhook's phone-matching path
  // (src/routes/sendblueWebhook.ts) — so format it for display and submit
  // it as E.164 (+1XXXXXXXXXX) without making anyone type the "+1" or
  // punctuation themselves.
  const phoneE164 = usPhoneToE164(phoneDigits);

  async function sendCode(e: FormEvent) {
    e.preventDefault();
    if (!phoneE164) return setError("Enter a 10-digit US phone number.");
    setError(null);
    setBusy(true);
    try {
      await api.requestLoginCode(phoneE164);
      setStep("code");
    } catch (err) {
      setError(errorMessage(err, "Couldn't send a code. Check the number and try again."));
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    if (!phoneE164) return setStep("phone");
    if (!code.trim()) return setError("Enter the 6-digit code from the text.");
    setError(null);
    setBusy(true);
    try {
      await api.verifyLoginCode(phoneE164, code.trim());
      onLoggedIn();
    } catch (err) {
      setError(errorMessage(err, "That code is invalid or has expired."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <h1>Home Base</h1>
      <p className="subtitle">Log in to your household.</p>
      {step === "phone" ? (
        <form className="card" onSubmit={sendCode}>
          <h2>Log in with your phone</h2>
          <div className="field">
            <label htmlFor="login-phone">Phone number</label>
            <input
              id="login-phone"
              type="tel"
              inputMode="numeric"
              autoFocus
              value={formatUsPhoneDisplay(phoneDigits)}
              onChange={(e) => setPhoneDigits(e.target.value.replace(/\D/g, ""))}
              placeholder="(303) 555-1234"
              required
            />
          </div>
          <button type="submit" disabled={busy || !phoneE164}>
            {busy ? "Sending…" : "Text me a code"}
          </button>
          <Notice notice={error ? { kind: "error", text: error } : null} onDismiss={() => setError(null)} style={{ marginTop: 12 }} />
          <p className="hint">
            Only a number already verified for a household member will receive a code. New here?{" "}
            <button type="button" className="link-button" onClick={onCreateHouseholdInstead}>
              Create a household
            </button>
            .
          </p>
        </form>
      ) : (
        <form className="card" onSubmit={verify}>
          <h2>Enter your code</h2>
          <p className="hint">We texted a 6-digit code to {formatUsPhoneDisplay(phoneDigits)}.</p>
          <div className="field">
            <label htmlFor="login-code">Code</label>
            <input
              id="login-code"
              type="text"
              inputMode="numeric"
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              required
            />
          </div>
          <button type="submit" disabled={busy}>
            {busy ? "Checking…" : "Log in"}
          </button>
          <button type="button" className="secondary" onClick={() => setStep("phone")}>
            Use a different number
          </button>
          <Notice notice={error ? { kind: "error", text: error } : null} onDismiss={() => setError(null)} style={{ marginTop: 12 }} />
        </form>
      )}
    </div>
  );
}
