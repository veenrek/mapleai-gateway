/**
 * MapleAI logo — stylized maple leaf (brand).
 */
type MapleAILogoProps = {
  size?: number;
  className?: string;
};

export default function MapleAILogo({ size = 20, className = "" }: MapleAILogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="MapleAI"
    >
      <path
        fill="currentColor"
        d="M32 6 L35.5 17.5 L45 12 L41.5 23.5 L53 20.5 L46.5 30 L58 32.5 L48.5 38.5 L54.5 47 L43 46 L45.5 57 L36 49.5 L33.5 58 L32 58 L30.5 58 L28 49.5 L18.5 57 L21 46 L9.5 47 L15.5 38.5 L6 32.5 L17.5 30 L11 20.5 L22.5 23.5 L19 12 L28.5 17.5 Z"
      />
    </svg>
  );
}
