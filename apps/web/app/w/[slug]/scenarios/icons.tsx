import type { StepAction } from "@defe2end/shared";
import type { ReactNode, SVGProps } from "react";

// Scenario-page icons, same stroke style as components/icons.tsx.
function Icon({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {children}
    </svg>
  );
}

const make = (children: ReactNode) => (p: SVGProps<SVGSVGElement>) => <Icon {...p}>{children}</Icon>;

export const SearchIcon = make(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>);
export const PlusIcon = make(<path d="M12 5v14M5 12h14" />);
export const CheckIcon = make(<path d="m5 12 5 5L20 7" />);
export const PlayIcon = make(<path d="m7 4 13 8-13 8z" />);
export const GripIcon = make(<><circle cx="9" cy="6" r="1" /><circle cx="15" cy="6" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="9" cy="18" r="1" /><circle cx="15" cy="18" r="1" /></>);
export const UploadIcon = make(<path d="M12 15V3M7 8l5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />);
export const DownloadIcon = make(<path d="M12 3v12M7 10l5 5 5-5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />);
export const ServerIcon = make(<><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></>);
export const ArchiveIcon = make(<><rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4" /></>);
export const RecordIcon = make(<><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2" /></>);
export const WriteIcon = make(<path d="M3 6h13M3 12h9M3 18h7M17 13v8M13 17h8" />);
export const FileJsonIcon = make(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M10 12l-2 2 2 2M14 12l2 2-2 2" /></>);
export const ListChecksIcon = make(<path d="m3 7 2 2 4-4M3 17l2 2 4-4M13 6h8M13 12h8M13 18h8" />);

const NAVIGATE_ICON = make(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>);
const CLICK_ICON = make(<path d="m9 9 5 12 1.8-5.2L21 14zM7.2 2.2 8 5.1M5.1 8 2.2 7.2M14 4.1 12 6.2M6.2 12l-2.1 2" />);
const ASSERT_ICON = make(<><path d="M3 6h18M3 12h8M3 18h8" /><circle cx="17" cy="16" r="3" /><path d="m21 20-1.8-1.8" /></>);

const FILL_ICON = make(<><path d="M5 4h1a3 3 0 0 1 3 3 3 3 0 0 1 3-3h1M13 20h-1a3 3 0 0 1-3-3 3 3 0 0 1-3 3H5M9 7v10" /><path d="M15 8h4a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-4" /></>);
const WAIT_ICON = make(<><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2 2M10 2h4" /></>);
const WINDOW_ICON = make(<><rect x="3" y="5" width="14" height="12" rx="2" /><path d="M7 21h12a2 2 0 0 0 2-2V9" /></>);
const FRAME_ICON = make(<><rect x="3" y="3" width="18" height="18" rx="2" /><rect x="7" y="7" width="10" height="10" rx="1" /></>);
const DIALOG_ICON = make(<path d="M4 5h16v11H9l-5 4z" />);

const ACTION_ICONS: Record<StepAction, (p: SVGProps<SVGSVGElement>) => ReactNode> = {
  goto: NAVIGATE_ICON,
  click: CLICK_ICON,
  fill: FILL_ICON,
  select: make(<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />),
  pressKey: CLICK_ICON,
  hover: CLICK_ICON,
  scroll: GripIcon,
  wait: WAIT_ICON,
  uploadFile: UploadIcon,
  clickFirstEnabled: CLICK_ICON,
  waitForSelector: WAIT_ICON,
  waitForUrl: WAIT_ICON,
  assertVisible: ASSERT_ICON,
  assertVisibleOrWarn: ASSERT_ICON,
  assertText: ASSERT_ICON,
  assertUrl: NAVIGATE_ICON,
  assertTitle: ASSERT_ICON,
  assertCount: ListChecksIcon,
  assertExists: ASSERT_ICON,
  assertJsonLd: FileJsonIcon,
  assertResponse: ServerIcon,
  screenshot: make(<><path d="M4 8a2 2 0 0 1 2-2h2l2-2h4l2 2h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /><circle cx="12" cy="13" r="3.5" /></>),
  clickAndWaitPopup: WINDOW_ICON,
  clickInPopup: WINDOW_ICON,
  fillInPopup: WINDOW_ICON,
  assertVisibleInPopup: WINDOW_ICON,
  assertPopupUrl: WINDOW_ICON,
  closePopup: WINDOW_ICON,
  clickInIframe: FRAME_ICON,
  fillInIframe: FRAME_ICON,
  assertVisibleInIframe: FRAME_ICON,
  clickAndAcceptDialog: DIALOG_ICON,
  clickAndDismissDialog: DIALOG_ICON,
  clickAndSubmitPrompt: DIALOG_ICON,
};

export function ActionIcon({ action, ...props }: { action: StepAction } & SVGProps<SVGSVGElement>) {
  // Steps saved in an older format may carry an action that no longer exists.
  const Component = ACTION_ICONS[action] ?? ASSERT_ICON;
  return <Component {...props} />;
}
