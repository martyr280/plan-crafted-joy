// Pure-TS linear algebra for ridge regression. No external deps.
// Solve (XᵀX + λP) β = Xᵀy via Cholesky. P = diag(1) except zeros on
// `noPenaltyCols` (default: [0] = intercept).

export type Matrix = number[][]; // row-major
export type Vector = number[];

export function matmulATA(X: Matrix): Matrix {
  const n = X.length;
  const p = X[0]?.length ?? 0;
  const A: Matrix = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let i = 0; i < n; i++) {
    const row = X[i];
    for (let a = 0; a < p; a++) {
      const ra = row[a];
      if (ra === 0) continue;
      for (let b = a; b < p; b++) {
        A[a][b] += ra * row[b];
      }
    }
  }
  for (let a = 0; a < p; a++) for (let b = 0; b < a; b++) A[a][b] = A[b][a];
  return A;
}

export function matmulATy(X: Matrix, y: Vector): Vector {
  const n = X.length;
  const p = X[0]?.length ?? 0;
  const b: Vector = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    const row = X[i];
    const yi = y[i];
    if (yi === 0) continue;
    for (let a = 0; a < p; a++) b[a] += row[a] * yi;
  }
  return b;
}

// Cholesky: returns lower-triangular L with A = L Lᵀ. Adds jitter on
// underflow so a near-singular X still solves (ridge already guards this).
export function cholesky(A: Matrix): Matrix {
  const n = A.length;
  const L: Matrix = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (s <= 1e-12) s = 1e-10;
        L[i][j] = Math.sqrt(s);
      } else {
        L[i][j] = s / L[j][j];
      }
    }
  }
  return L;
}

export function solveLower(L: Matrix, b: Vector): Vector {
  const n = L.length;
  const y: Vector = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
    y[i] = s / L[i][i];
  }
  return y;
}

export function solveUpperFromL(L: Matrix, y: Vector): Vector {
  // Solve Lᵀ x = y
  const n = L.length;
  const x: Vector = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k];
    x[i] = s / L[i][i];
  }
  return x;
}

export function ridgeSolve(
  X: Matrix,
  y: Vector,
  lambda: number,
  noPenaltyCols: number[] = [0],
): Vector {
  const A = matmulATA(X);
  const b = matmulATy(X, y);
  const noPen = new Set(noPenaltyCols);
  for (let i = 0; i < A.length; i++) if (!noPen.has(i)) A[i][i] += lambda;
  const L = cholesky(A);
  const z = solveLower(L, b);
  return solveUpperFromL(L, z);
}

export function predict(x: Vector, beta: Vector): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * beta[i];
  return s;
}

export function mean(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function mad(nums: number[]): number {
  if (nums.length === 0) return 0;
  const m = mean(nums);
  return mean(nums.map((n) => Math.abs(n - m)));
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
