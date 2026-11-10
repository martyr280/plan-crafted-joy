import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { EST_PALLETS_UNAVAILABLE, formatEstPallets } from "@/lib/truck-capacity/est-pallets";

/** Keyboard-focusable explanation of the cube pallet formula. Does not navigate the row. */
export function EstPalletsTrigger({ code, estPallets }: { code: string; estPallets: number | null }) {
  const shown = formatEstPallets(estPallets);
  const text = shown === EST_PALLETS_UNAVAILABLE ? "pallets unavailable" : `${shown} est. pallets`;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="block max-w-full text-left text-[11px] text-muted-foreground underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            data-testid={`est-pallets-${code}`}
            aria-label={`${code} estimated pallets: ${shown === EST_PALLETS_UNAVAILABLE ? "unavailable" : shown}. Cube divided by cube per full truck divided by pallets per full truck.`}
            onClick={(event) => event.stopPropagation()}
          >
            {text}
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          Estimated pallets = cube ÷ (cube per full truck ÷ pallets per full truck), from this route&apos;s Truck Capacity settings. Missing, zero, or negative cube or capacity shows as unavailable. A previously saved pallet count is not reused.
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
