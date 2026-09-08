// Something to look at while the model thinks.
//
// This exists because Vaan does not stream. Streaming buys one thing — the
// terminal stops looking frozen — at the cost of reassembling a turn from
// fragments in every adapter, which is where most of the provider bugs came
// from. A line that says how long you have been waiting buys the same thing for
// forty lines and no reassembly.
//
// It is honest about what it knows: elapsed time, and nothing else. No fake
// progress bar, because nobody knows how far through a reply the model is.

import { DOT, duration, type Theme } from "./theme.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 80;

export interface Spinner {
  /** Begin, or relabel without restarting the clock. */
  start(label: string): void;
  /** Erase the line. Safe to call when not running. */
  stop(): void;
}

export interface SpinnerOptions {
  out: NodeJS.WriteStream;
  theme: Theme;
  /** Off for pipes and dumb terminals: an animation there is line noise. */
  animate?: boolean;
}

export function createSpinner(opts: SpinnerOptions): Spinner {
  const { out, theme } = opts;
  const animate = opts.animate ?? (out.isTTY ?? false);

  let timer: NodeJS.Timeout | undefined;
  let startedAt = 0;
  let frame = 0;
  let label = "";

  const clear = (): void => {
    // Carriage return and erase-line, so the next write starts on clean ground
    // rather than on top of half a spinner.
    out.write("\r[2K");
  };

  const draw = (): void => {
    clear();
    const spin = FRAMES[frame % FRAMES.length] ?? "";
    frame++;
    out.write(theme.dim(`${spin} ${label} ${DOT} ${duration(Date.now() - startedAt)}`));
  };

  return {
    start(next) {
      label = next;
      if (!animate) return;
      if (timer) return; // Relabel in place; the clock keeps running.
      startedAt = Date.now();
      frame = 0;
      draw();
      timer = setInterval(draw, INTERVAL_MS);
      // Never hold the process open for the sake of an animation.
      timer.unref?.();
    },

    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
      clear();
    },
  };
}
