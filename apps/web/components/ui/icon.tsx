/**
 * Iconos de las pantallas de acceso: dibujados aquí con un único trazo (1,75 px en una caja de 20) para que la
 * familia sea coherente. Sin librería externa ni emoji. Siempre decorativos: el texto acompañante da el nombre.
 */
const PATHS = {
  eye: (
    <>
      <path d="M1.75 10s3-5.75 8.25-5.75S18.25 10 18.25 10 15.25 15.75 10 15.75 1.75 10 1.75 10Z" />
      <circle cx="10" cy="10" r="2.5" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M8.2 4.45A8.6 8.6 0 0 1 10 4.25c5.25 0 8.25 5.75 8.25 5.75a14.6 14.6 0 0 1-2.1 2.85M5.55 5.55C3.25 7.05 1.75 10 1.75 10s3 5.75 8.25 5.75a8.1 8.1 0 0 0 4.45-1.3" />
      <path d="M8.25 8.25a2.5 2.5 0 0 0 3.5 3.5" />
      <path d="m2.5 2.5 15 15" />
    </>
  ),
  alert: (
    <>
      <circle cx="10" cy="10" r="7.75" />
      <path d="M10 6.25v4.5M10 13.5v.25" />
    </>
  ),
  arrowRight: <path d="M4.25 10h11.5M11 5.25 15.75 10 11 14.75" />,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = 'size-5' }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {PATHS[name]}
    </svg>
  );
}
