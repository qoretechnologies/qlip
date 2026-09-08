import { createPortal } from 'react-dom';

export interface IBodyPortalProps {
  /** Label of the portalled toolbar; the toolbar sizes itself to it. */
  label?: string;
}

/**
 * Renders a fixed-position toolbar straight into <body>, the way UI
 * libraries portal floating actions, popovers and dropdowns. Like those, it
 * carries no explicit width/height and sizes itself to its content, so a
 * capture-time rule that stretches <body> children would balloon it.
 */
export const BodyPortal = ({ label = 'floating actions' }: IBodyPortalProps) => (
  <div style={{ height: '100%', padding: 16, boxSizing: 'border-box' }}>
    <h1>A toolbar portalled into body sits at the bottom right</h1>
    {createPortal(
      <div
        className="body-portal-toolbar"
        data-testid="body-portal"
        style={{
          position: 'fixed',
          right: 16,
          bottom: 16,
          padding: '6px 12px',
          background: '#1d4ed8',
          color: '#fff',
          borderRadius: 4,
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </div>,
      document.body,
    )}
  </div>
);
