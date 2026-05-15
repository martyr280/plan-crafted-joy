import nelsonAiLogo from "@/assets/nelson-ai-logo.png";
import { cn } from "@/lib/utils";

type LogoProps = {
  size?: number;
  className?: string;
  rounded?: "md" | "lg";
  shadow?: "soft" | "glow" | "none";
  alt?: string;
};

/**
 * Shared Nelson AI mark. Always renders the logo inside a square container
 * with consistent padding and aspect ratio so it looks identical everywhere.
 */
export function Logo({
  size = 32,
  className,
  rounded = "md",
  shadow = "soft",
  alt = "Nelson AI",
}: LogoProps) {
  const shadowClass =
    shadow === "glow"
      ? "shadow-[var(--shadow-glow)]"
      : shadow === "soft"
        ? "shadow-[var(--shadow-soft)]"
        : "";
  const roundedClass = rounded === "lg" ? "rounded-lg" : "rounded-md";

  return (
    <div
      style={{ width: size, height: size }}
      className={cn(
        "shrink-0 aspect-square overflow-hidden bg-primary flex items-center justify-center p-[12%]",
        roundedClass,
        shadowClass,
        className,
      )}
    >
      <img
        src={nelsonAiLogo}
        alt={alt}
        width={size}
        height={size}
        className="w-full h-full object-contain"
      />
    </div>
  );
}
