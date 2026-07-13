import type { ReactElement } from 'react'

interface IconProps {
  size?: number
}

const strokeBase = {
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

export function SunIcon({ size = 15 }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      {...strokeBase}
      strokeWidth={1.3}
    >
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1" />
    </svg>
  )
}

export function MoonIcon({ size = 15 }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      {...strokeBase}
      strokeWidth={1.3}
    >
      <path d="M13.2 9.6A5.3 5.3 0 0 1 6.4 2.8 5.4 5.4 0 1 0 13.2 9.6Z" />
    </svg>
  )
}

export function PlusIcon({ size = 15 }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      {...strokeBase}
      strokeWidth={1.5}
    >
      <path d="M8 3.4v9.2M3.4 8h9.2" />
    </svg>
  )
}

export function PlusThinIcon({ size = 14 }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      {...strokeBase}
      strokeWidth={1.4}
    >
      <path d="M8 4v8M4 8h8" />
    </svg>
  )
}

export function HistoryIcon({ size = 15 }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      {...strokeBase}
      strokeWidth={1.3}
    >
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 4.5V8l2.4 1.5" />
    </svg>
  )
}

export function NewChatIcon({ size = 16 }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      {...strokeBase}
      strokeWidth={1.3}
    >
      <path d="M3.2 11.7A5.7 5.7 0 1 1 5 13l-2.6.8.8-2.1Z" />
      <path d="M8 5.3v5.4M5.3 8h5.4" />
    </svg>
  )
}

export function MinusIcon({ size = 15 }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      {...strokeBase}
      strokeWidth={1.5}
    >
      <path d="M3.4 8h9.2" />
    </svg>
  )
}

export function ChevronUpIcon({ size = 15 }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      {...strokeBase}
      strokeWidth={1.4}
    >
      <path d="M4.5 9.5 8 6l3.5 3.5" />
    </svg>
  )
}

export function ChevronDownIcon({ size = 15 }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      {...strokeBase}
      strokeWidth={1.4}
    >
      <path d="M4.5 6.5 8 10l3.5-3.5" />
    </svg>
  )
}

export function ChevronRightIcon({ size = 9 }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      {...strokeBase}
      strokeWidth={2}
    >
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  )
}

export function SearchIcon({ size = 13 }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      {...strokeBase}
      strokeWidth={1.4}
    >
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.2 10.2 13.4 13.4" />
    </svg>
  )
}

export function GlobeIcon({ size = 14 }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      {...strokeBase}
      strokeWidth={1.3}
    >
      <circle cx="8" cy="8" r="5.5" />
      <path d="M2.5 8h11" />
      <ellipse cx="8" cy="8" rx="2.6" ry="5.5" />
    </svg>
  )
}

export function CloseIcon({ size = 14 }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      {...strokeBase}
      strokeWidth={1.5}
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  )
}

export function EyeIcon({ size = 15 }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      {...strokeBase}
      strokeWidth={1.3}
    >
      <path d="M1.7 8S4 4.2 8 4.2 14.3 8 14.3 8 12 11.8 8 11.8 1.7 8 1.7 8Z" />
      <circle cx="8" cy="8" r="1.7" />
    </svg>
  )
}

export function CheckIcon({ size = 13 }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      {...strokeBase}
      strokeWidth={1.7}
    >
      <path d="M3.5 8.5 6.5 11.5 12.5 5" />
    </svg>
  )
}

export function KeyIcon({ size = 12 }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      {...strokeBase}
      strokeWidth={1.4}
    >
      <circle cx="5.6" cy="6" r="2.3" />
      <path d="M7.3 7.6 12.5 12.8M10.4 10.7l1.3-1.3M11.7 12l1.3-1.3" />
    </svg>
  )
}

export function SqlFileIcon({ size = 13 }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="var(--accent)"
      strokeWidth={1.3}
      strokeLinecap="round"
    >
      <path d="M4.5 5.5h7M4.5 8h7M4.5 10.5h4" />
    </svg>
  )
}

export function BookIcon({ size = 12 }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      {...strokeBase}
      strokeWidth={1.3}
    >
      <path d="M2.5 3.2A1.7 1.7 0 0 1 4.2 1.5h9.3v11.7H4.2a1.7 1.7 0 0 0-1.7 1.7Z" />
      <path d="M2.5 13.2V3.2M13.5 10.4H4.2a1.7 1.7 0 0 0-1.7 1.7" />
    </svg>
  )
}

export function PlayIcon({ size = 11 }: IconProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor">
      <path d="M4 3l9 5-9 5z" />
    </svg>
  )
}

export function SparkleIcon({ size = 13 }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      {...strokeBase}
      strokeWidth={1.3}
    >
      <path d="M8 2.2 9.5 6l3.8 1.5L9.5 9 8 12.8 6.5 9 2.7 7.5 6.5 6z" />
    </svg>
  )
}

export function PinIcon({ size = 12 }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      {...strokeBase}
      strokeWidth={1.3}
    >
      <path d="M5.5 2h5M6.5 2v3.8L4.2 8.6h7.6L9.5 5.8V2M8 8.6V14" />
    </svg>
  )
}

export function RefreshIcon({ size = 12 }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      {...strokeBase}
      strokeWidth={1.4}
    >
      <path d="M13.4 8A5.4 5.4 0 1 1 11.6 3.97" />
      <path d="M11.9 1.3v2.9h2.9" />
    </svg>
  )
}

export function ArrowUpIcon({ size = 16 }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      {...strokeBase}
      strokeWidth={1.7}
    >
      <path d="M8 13V4M4.5 7.5 8 3.8l3.5 3.7" />
    </svg>
  )
}

export function StopIcon({ size = 12 }: IconProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor">
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
    </svg>
  )
}

export function KebabIcon({ size = 15 }: IconProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor">
      <circle cx="8" cy="3.4" r="1.35" />
      <circle cx="8" cy="8" r="1.35" />
      <circle cx="8" cy="12.6" r="1.35" />
    </svg>
  )
}

export function CubeIcon({ size = 12 }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      {...strokeBase}
      strokeWidth={1.2}
    >
      <path d="M8 2.3 13.4 5.2v5.6L8 13.7 2.6 10.8V5.2z" />
      <path d="M2.7 5.3 8 8.1l5.3-2.8" />
      <path d="M8 8.1v5.5" />
    </svg>
  )
}

export function RowsIcon({ size = 12 }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      {...strokeBase}
      strokeWidth={1.3}
    >
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h7" />
    </svg>
  )
}

export function FormatIcon({ size = 14 }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      {...strokeBase}
      strokeWidth={1.3}
    >
      <path d="M3 4.5h10M3 8h7M3 11.5h10" />
    </svg>
  )
}

export function SaveIcon({ size = 14 }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      {...strokeBase}
      strokeWidth={1.3}
    >
      <path d="M3 3.8v8.4c0 .6.4 1 1 1h8c.6 0 1-.4 1-1V5.6L10.4 3H4c-.6 0-1 .4-1 1z" />
      <path d="M5.5 3.2v3h4v-3M5.5 13v-3.4h5V13" />
    </svg>
  )
}

export function ExportIcon({ size = 14 }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      {...strokeBase}
      strokeWidth={1.35}
    >
      <path d="M8 2.2v7.3M5.2 6.8 8 9.6l2.8-2.8" />
      <path d="M3 10.2v2.6h10v-2.6" />
    </svg>
  )
}

export function ShieldIcon({ size = 12 }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      {...strokeBase}
      strokeWidth={1.3}
    >
      <path d="M8 1.8 13 3.6v4.1c0 3.4-2.2 5.7-5 6.5-2.8-.8-5-3.1-5-6.5V3.6z" />
    </svg>
  )
}

export function PlugIcon({ size = 13 }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      {...strokeBase}
      strokeWidth={1.3}
    >
      <path d="M5.2 1.6v3.2M10.8 1.6v3.2M4 4.8h8M5.2 4.8v2.4a2.8 2.8 0 0 0 5.6 0V4.8M8 10v4.4" />
    </svg>
  )
}

export function FolderIcon({ size = 14 }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      {...strokeBase}
      strokeWidth={1.3}
    >
      <path d="M2 4.3c0-.6.5-1.1 1.1-1.1h3l1.3 1.6h5.5c.6 0 1.1.5 1.1 1.1v5.8c0 .6-.5 1.1-1.1 1.1H3.1c-.6 0-1.1-.5-1.1-1.1z" />
    </svg>
  )
}

export function DatabaseIcon({ size = 18 }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      {...strokeBase}
      strokeWidth={1.2}
    >
      <ellipse cx="8" cy="4" rx="4.8" ry="1.9" />
      <path d="M3.2 4v8c0 1 2.15 1.9 4.8 1.9s4.8-.9 4.8-1.9V4" />
      <path d="M3.2 8c0 1 2.15 1.9 4.8 1.9s4.8-.9 4.8-1.9" />
    </svg>
  )
}
