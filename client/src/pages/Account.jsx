import MyAccount from '../components/MyAccount';

// The signed-in user's own account page (profile + password). Separate from the
// admin Settings page. The MyAccount component renders nothing when nobody is
// signed in, so the route is harmless in that state.
export default function Account() {
  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 20 }}>My Account</h1>
      <MyAccount />
    </div>
  );
}
