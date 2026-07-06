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
