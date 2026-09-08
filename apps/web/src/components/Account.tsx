import { ErrorNotice, Loading, Shell, useSession } from "./Shared";
import ProfileForm from "./ProfileForm";

export default function Account() {
  const { user, setUser, error } = useSession();
  return (
    <Shell user={user} active="account" currentPage="Account settings">
      <div className="settings-body">
        <h1>Account settings</h1>
        <p className="muted">Manage your personal details and sign-in credentials.</p>
        <ErrorNotice error={error} />
        {error ? <button onClick={() => window.location.reload()}>Reload account</button> : !user ? <Loading /> : (
          <ProfileForm user={user} setUser={setUser} />
        )}
      </div>
    </Shell>
  );
}
