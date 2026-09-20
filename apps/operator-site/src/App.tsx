export function App() {
  return (
    <main
      style={{
        minHeight: "100dvh",
        background: "var(--tg-harbor)",
        color: "var(--tg-foam)",
        padding: "var(--space-8) var(--space-4)",
      }}
    >
      <p
        style={{
          fontSize: "var(--text-xs)",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--tg-tide-lime)",
        }}
      >
        Demo build, synthetic data
      </p>
      <h1>Operator console</h1>
      <p style={{ color: "var(--tg-mist)" }}>
        Sign-in, calendar, and bookings arrive with the tenancy and console goals. This page proves
        the console deploys separately from the guest surface.
      </p>
    </main>
  );
}
