export interface ITallPageProps {
  /** Sections in the scrolling column; each is 240px tall. */
  sections?: number;
}

/**
 * An app shell the way real ones are built: the document is pinned to the
 * viewport and never scrolls, a header stays put, and a column below it
 * scrolls its own content. A one-screen capture of this page shows the
 * header and the first sections; everything else is inside the column's
 * scroll, where neither the document height nor a browser "full page"
 * screenshot can see it.
 */
export const TallPage = ({ sections = 12 }: ITallPageProps) => (
  <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
    <header
      style={{
        flex: '0 0 56px',
        display: 'flex',
        alignItems: 'center',
        padding: '0 16px',
        background: '#1d4ed8',
        color: '#fff',
        fontWeight: 600,
      }}
    >
      Inbox
    </header>
    <main data-testid="tall-page-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      {Array.from({ length: sections }, (_, index) => (
        <section
          key={index}
          style={{
            height: 240,
            boxSizing: 'border-box',
            padding: 16,
            borderBottom: '1px solid #e5e7eb',
            background: index % 2 ? '#f9fafb' : '#fff',
          }}
        >
          <h2 style={{ margin: 0 }}>Section {index + 1}</h2>
          <p>Message {index + 1} of {sections}.</p>
        </section>
      ))}
    </main>
  </div>
);

/**
 * An ordinary page, nothing pinned, whose only scroller is a fixed-height
 * box (a code block, a capped list). Growing the viewport never grows that
 * box, so a `fullPage` capture has nothing to reveal and stays one screen.
 */
export const FixedBoxPage = () => (
  <div style={{ padding: 16, fontFamily: 'sans-serif' }}>
    <h1 style={{ margin: 0 }}>Release notes</h1>
    <pre
      data-testid="fixed-box"
      style={{ height: 200, margin: '16px 0', overflowY: 'auto', border: '1px solid #d1d5db' }}
    >
      {Array.from({ length: 100 }, (_, index) => `line ${String(index + 1)}`).join('\n')}
    </pre>
    <p style={{ margin: 0 }}>The page ends here.</p>
  </div>
);
