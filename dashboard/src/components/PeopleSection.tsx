import { useState, type FormEvent } from "react";
import { api, type User } from "../api";
import { formatUsPhoneDisplay, usPhoneToE164, VALIDATION } from "../copy";
import { Notice, useAction } from "./Notice";
import { EmptyRow } from "./EmptyState";

interface Props {
  householdId: string;
  users: User[];
  onChanged: () => Promise<void>;
}

export function PeopleSection({ householdId, users, onChanged }: Props) {
  const [name, setName] = useState("");
  const [phoneDrafts, setPhoneDrafts] = useState<Record<string, string>>({});
  const action = useAction();

  async function addUser(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return action.showError(VALIDATION.name);
    const ok = await action.run(
      async () => {
        await api.createUser(householdId, { name: trimmed });
        await onChanged();
      },
      { key: "add", success: `${trimmed} added.` },
    );
    if (ok) setName("");
  }

  async function verify(user: User) {
    const phone = usPhoneToE164(phoneDrafts[user.id] ?? "");
    if (!phone) return action.showError("Enter a 10-digit US phone number, like (303) 555-1234.");
    await action.run(
      async () => {
        await api.verifyPhone(householdId, user.id, phone);
        await onChanged();
      },
      { key: user.id, success: `${user.name} can now text the bot from ${formatUsPhoneDisplay(phone.slice(2))}.` },
    );
  }

  return (
    <section className="card">
      <h2>People</h2>
      <ul className="list">
        {users.map((u) => (
          <li key={u.id}>
            <span>{u.name}</span>
            {u.phone_verified_at ? (
              <span className="badge badge--soft badge--positive">{u.phone_e164 ? formatUsPhoneDisplay(u.phone_e164.replace(/^\+1/, "")) : "verified"}</span>
            ) : (
              <span className="row">
                <input
                  type="tel"
                  inputMode="numeric"
                  aria-label={`${u.name}'s phone number`}
                  placeholder="(303) 555-1234"
                  value={formatUsPhoneDisplay(phoneDrafts[u.id] ?? "")}
                  disabled={action.busyKey === u.id}
                  onChange={(e) => setPhoneDrafts((d) => ({ ...d, [u.id]: e.target.value.replace(/\D/g, "") }))}
                  style={{ width: 150 }}
                />
                <button className="secondary" type="button" disabled={action.busy} onClick={() => verify(u)}>
                  {action.busyKey === u.id ? "Verifying…" : "Verify"}
                </button>
              </span>
            )}
          </li>
        ))}
        {users.length === 0 && (
          <li>
            <EmptyRow text="No one added yet." />
          </li>
        )}
      </ul>
      <p className="hint">
        Before verifying a number, that phone must text your Sendblue number once — the free plan only allows messaging numbers that have already
        said hello.
      </p>
      <form className="row" onSubmit={addUser} style={{ marginTop: "0.75rem", alignItems: "flex-end" }}>
        <div className="field-inline">
          <label htmlFor="people-new-name">Name</label>
          <input id="people-new-name" type="text" value={name} disabled={action.busy} onChange={(e) => setName(e.target.value)} />
        </div>
        <button type="submit" disabled={action.busy}>
          {action.busyKey === "add" ? "Adding…" : "Add member"}
        </button>
      </form>
      <Notice notice={action.notice} onDismiss={action.clear} style={{ marginTop: 12 }} />
    </section>
  );
}
