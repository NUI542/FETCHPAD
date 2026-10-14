export default function Field({ value, onChange }) {
  return <input value={value} onChange={onChange} />;
}

export function Guard({ children }) {
  return children;
}

export function Layout() {
  return <main />;
}
