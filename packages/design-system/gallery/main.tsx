import "../src/base.css";
import "./gallery.css";
import {
  type CSSProperties,
  StrictMode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  applyBrandTheme,
  type BrandTheme,
  bodyFonts,
  contrastRatio,
  displayFonts,
  tidegridTheme,
} from "../src/brand/index.ts";
import {
  Button,
  ButtonLink,
  EmptyState,
  Icon,
  iconNames,
  Notice,
  Skeleton,
  Spinner,
  StatusBadge,
  type StatusTone,
  TextField,
} from "../src/components/index.ts";
import { comfortableLine, measureReport } from "./line-length.ts";

/** Sample themes: the TideGrid default and the two synthetic tenants' theme inputs. */
const themes: Record<string, BrandTheme> = {
  TideGrid: tidegridTheme,
  "Demo Harbor": {
    colors: { primary: "#0b3c5d", accent: "#e0a526" },
    fonts: { display: "fraunces", body: "source-sans-3" },
  },
  "Demo Reef": {
    colors: { primary: "#006d77", accent: "#ffd166" },
    fonts: { display: "bricolage-grotesque", body: "atkinson-hyperlegible-next" },
  },
};

const palette = [
  ["Deep Forest", "#0e2b1f"],
  ["Pine Green", "#143f2e"],
  ["Tide Lime", "#a7d129"],
  ["Mist", "#e8ece8"],
  ["Foam", "#f6f7f6"],
  ["Harbor", "#1a1f1d"],
] as const;

const statuses = [
  ["ready", "Ready", "#2e7d32", "#a7d129"],
  ["warning", "Warning", "#9a5200", "#ffb020"],
  ["blocked", "Blocked", "#b42318", "#ff7a70"],
  ["info", "Information", "#00639b", "#5cc8ff"],
  ["pending", "Pending", "#6941c6", "#c2a5ff"],
] as const;

const scale = [
  ["48", "var(--text-4xl)"],
  ["36", "var(--text-3xl)"],
  ["28", "var(--text-2xl)"],
  ["22", "var(--text-xl)"],
  ["18", "var(--text-lg)"],
  ["16", "var(--text-md)"],
  ["14", "var(--text-sm)"],
  ["12", "var(--text-xs)"],
] as const;

/** Copy the calibration never saw, so the check tests the measure, not the sample. */
const measureSample =
  "Meet at dock B fifteen minutes before departure. The captain checks the weather at dawn and sends an update by seven if the trip moves or changes. Bring sunscreen, a light jacket, and water; snacks are on board. Children under twelve travel with an adult, and every guest wears a life jacket while the boat is underway. If the forecast turns, pick another date or take a full refund.";

type MeasureRow = { id: string; label: string; measure: string } & ReturnType<typeof measureReport>;

/**
 * Sets the sample in each body font at that font's measure, through the same
 * `--measure` property and `p { max-width }` rule the apps use, and counts the
 * characters on every rendered line.
 */
function MeasureCheck() {
  const samples = useRef<Map<string, HTMLParagraphElement>>(new Map());
  const [rows, setRows] = useState<MeasureRow[]>([]);
  useEffect(() => {
    let live = true;
    const run = () => {
      if (!live) return;
      setRows(
        Object.entries(bodyFonts).flatMap(([id, font]) => {
          const el = samples.current.get(id);
          return el ? [{ id, label: font.label, measure: font.measure, ...measureReport(el) }] : [];
        }),
      );
    };
    void document.fonts.ready.then(run);
    window.addEventListener("resize", run);
    return () => {
      live = false;
      window.removeEventListener("resize", run);
    };
  }, []);
  return (
    <>
      <p className="tg-muted">
        Every line within {comfortableLine.min} to {comfortableLine.max} characters, counted from
        the rendered layout. Narrow screens give shorter lines.
      </p>
      <table className="gallery-measure" data-testid="measure-check">
        <thead>
          <tr>
            <th scope="col">Body font</th>
            <th scope="col">Measure</th>
            <th scope="col">Longest line</th>
            <th scope="col">Average line</th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} data-font={row.id} data-longest={row.longest} data-ok={row.ok}>
              <th scope="row">{row.label}</th>
              <td>{row.measure}</td>
              <td>{row.longest}</td>
              <td>{row.average}</td>
              <td>
                <StatusBadge tone={row.ok ? "ready" : "blocked"}>
                  {row.ok ? "Within range" : "Out of range"}
                </StatusBadge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {Object.entries(bodyFonts).map(([id, font]) => (
        <div
          key={id}
          className="gallery-measure__sample"
          style={{ fontFamily: font.stack, "--measure": font.measure } as CSSProperties}
        >
          <p className="tg-eyebrow">{font.label}</p>
          <p
            ref={(el) => {
              if (el) samples.current.set(id, el);
              else samples.current.delete(id);
            }}
          >
            {measureSample}
          </p>
        </div>
      ))}
    </>
  );
}

const ratio = (a: string, b: string) =>
  `${(Math.floor(contrastRatio(a, b) * 100) / 100).toFixed(2)}:1`;

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="gallery-section" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

function Components({ dark }: { dark: boolean }) {
  const [busy, setBusy] = useState(false);
  const tones: StatusTone[] = ["ready", "warning", "blocked", "info", "pending", "neutral"];
  return (
    <>
      <Section id={`buttons-${dark}`} title="Buttons">
        <div className="gallery-row">
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="primary" icon="phone">
            With icon
          </Button>
        </div>
        <div className="gallery-row">
          <Button variant="primary" disabled>
            Unavailable
          </Button>
          <Button variant="secondary" disabled>
            Unavailable
          </Button>
          <Button variant="primary" busy busyLabel="Sending…">
            Send
          </Button>
          <Button
            variant="secondary"
            busy={busy}
            busyLabel="Working…"
            onClick={() => {
              setBusy(true);
              window.setTimeout(() => setBusy(false), 1500);
            }}
          >
            Press for busy
          </Button>
          <ButtonLink variant="ghost" icon="mail" href="#buttons">
            Link as button
          </ButtonLink>
        </div>
      </Section>
      <Section id={`fields-${dark}`} title="Text fields">
        <div className="gallery-grid">
          <TextField label="Work email" type="email" placeholder="name@example.com" />
          <TextField
            label="With a hint"
            hint="We send a single-use link."
            defaultValue="ava@demo-harbor.test"
          />
          <TextField label="Invalid" defaultValue="ava@" error="Enter your work email address." />
          <TextField label="Unavailable" defaultValue="locked@demo-harbor.test" disabled />
        </div>
      </Section>
      <Section id={`status-${dark}`} title="Status: icon plus label">
        <div className="gallery-row">
          {tones.map((t) => (
            <StatusBadge key={t} tone={t}>
              {t === "ready" ? "Active" : t[0]?.toUpperCase() + t.slice(1)}
            </StatusBadge>
          ))}
        </div>
      </Section>
      <Section id={`notices-${dark}`} title="Notices">
        <div className="gallery-stack">
          <Notice tone="info" title="Information" announce="none">
            <p>Neutral guidance with an icon and a title.</p>
          </Notice>
          <Notice tone="success" title="Check your email" announce="none">
            <p>A sign-in link is on its way.</p>
          </Notice>
          <Notice tone="warning" title="Almost full" announce="none">
            <p>Two seats remain on this trip.</p>
          </Notice>
          <Notice
            tone="error"
            title="The console can't reach the API"
            announce="none"
            actions={
              <Button variant="primary" icon="refresh">
                Try again
              </Button>
            }
          >
            <p>Check your connection and try again.</p>
          </Notice>
        </div>
      </Section>
      <Section id={`empty-${dark}`} title="Empty state">
        <EmptyState
          icon="calendar"
          headingLevel={3}
          title="No trips are open for online booking yet"
          actions={
            <>
              <Button variant="primary" icon="phone">
                Call (305) 555-0142
              </Button>
              <Button variant="ghost" icon="mail">
                Email instead
              </Button>
            </>
          }
        >
          <p>Trips appear here once online booking opens.</p>
        </EmptyState>
      </Section>
      <Section id={`loading-${dark}`} title="Loading">
        <div className="gallery-row" aria-hidden="true">
          <Skeleton variant="circle" width="2.5rem" height="2.5rem" />
          <div className="gallery-stack gallery-grow">
            <Skeleton variant="text" width="60%" />
            <Skeleton variant="text" width="40%" />
          </div>
          <Spinner />
        </div>
      </Section>
    </>
  );
}

function Gallery() {
  const [themeName, setThemeName] = useState("TideGrid");
  const theme = themes[themeName] ?? tidegridTheme;
  useLayoutEffect(() => applyBrandTheme(document.documentElement, theme), [theme]);

  return (
    <div className="gallery">
      <header className="gallery-header">
        <h1>TideGrid design system</h1>
        <p className="tg-muted">
          Tokens, self-hosted fonts, and components in every state. Light is the guest surface with
          the chosen brand; dark is the operator console.
        </p>
        <fieldset className="gallery-themes">
          <legend>Guest brand</legend>
          {Object.keys(themes).map((name) => (
            <label key={name} className="gallery-choice">
              <input
                type="radio"
                name="theme"
                value={name}
                checked={name === themeName}
                onChange={() => setThemeName(name)}
              />
              {name}
            </label>
          ))}
        </fieldset>
      </header>

      <div className="gallery-panes">
        <div className="gallery-pane">
          <p className="tg-eyebrow">Light guest surface, {themeName}</p>
          <div className="gallery-band">
            <p className="gallery-band__eyebrow">Book online</p>
            <p className="gallery-band__title">{themeName} brand band</p>
            <p>
              Ink {ratio(theme.colors.primary, "#ffffff")} on primary. Accent{" "}
              {ratio(theme.colors.accent, theme.colors.primary)} against primary.
            </p>
          </div>
          <Components dark={false} />
        </div>
        <div className="gallery-pane gallery-pane--dark tg-dark">
          <p className="tg-eyebrow">Dark operator console</p>
          <Components dark />
        </div>
      </div>

      <Section id="palette" title="Palette and status colors">
        <div className="gallery-swatches">
          {palette.map(([name, hex]) => (
            <figure key={name} className="gallery-swatch">
              <span className="gallery-swatch__chip" style={{ background: hex }} />
              <figcaption>
                <strong>{name}</strong> {hex}
                <br />
                <span className="tg-muted">
                  {ratio(hex, "#f6f7f6")} on Foam, {ratio(hex, "#1a1f1d")} on Harbor
                </span>
              </figcaption>
            </figure>
          ))}
          {statuses.map(([id, name, light, dark]) => (
            <figure key={id} className="gallery-swatch">
              <span className="gallery-swatch__pair">
                <span className="gallery-swatch__chip" style={{ background: light }} />
                <span className="gallery-swatch__chip" style={{ background: dark }} />
              </span>
              <figcaption>
                <strong>{name}</strong> {light} / {dark}
                <br />
                <span className="tg-muted">
                  {ratio(light, "#f6f7f6")} on Foam, {ratio(dark, "#1a1f1d")} on Harbor
                </span>
              </figcaption>
            </figure>
          ))}
        </div>
      </Section>

      <Section id="type" title="Type scale">
        <div className="gallery-stack">
          {scale.map(([px, size]) => (
            <p key={px} className="gallery-type" style={{ fontSize: size }}>
              <span className="gallery-type__label">{px}</span>
              {Number(px) >= 22 ? (
                <span style={{ fontFamily: "var(--font-display)" }}>
                  Sunset sail from the marina
                </span>
              ) : (
                <span>Half-day reef trip, two seats left, meets at dock B at 8:00 a.m.</span>
              )}
            </p>
          ))}
        </div>
      </Section>

      <Section id="fonts" title="Supported fonts">
        <div className="gallery-grid">
          {[...Object.entries(displayFonts), ...Object.entries(bodyFonts)].map(([id, font]) => (
            <figure key={id} className="gallery-font" style={{ fontFamily: font.stack }}>
              <p className="gallery-font__sample">Aa Harbor 0123</p>
              <figcaption className="tg-muted">
                {font.label} ({id in displayFonts ? "display" : "body"}), OFL, self-hosted
              </figcaption>
            </figure>
          ))}
        </div>
      </Section>

      <Section id="measure" title="Reading measure">
        <MeasureCheck />
      </Section>

      <Section id="icons" title="Icons">
        <ul className="gallery-icons">
          {iconNames.map((name) => (
            <li key={name}>
              <Icon name={name} />
              <span>{name}</span>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("root element missing");
createRoot(root).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);
