import { describe, it, expect } from "vitest";
import { ridgeSolve, cholesky, matmulATA, predict } from "../linalg";

describe("linalg", () => {
  it("cholesky reproduces A = L Lᵀ on SPD matrix", () => {
    const A = [[4, 2, 0], [2, 5, 1], [0, 1, 3]];
    const L = cholesky(A);
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) expect(L[i][j]).toBe(0);
    // Reconstruct
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        let s = 0;
        for (let k = 0; k < 3; k++) s += L[i][k] * L[j][k];
        expect(s).toBeCloseTo(A[i][j], 8);
      }
    }
  });

  it("ridge shrinks toward zero as lambda grows", () => {
    // y = 2*x1 + noise, single feature after intercept.
    const X = [[1, 1], [1, 2], [1, 3], [1, 4], [1, 5]];
    const y = [2, 4, 6, 8, 10];
    const b0 = ridgeSolve(X, y, 0.001, [0]);
    const b1 = ridgeSolve(X, y, 100, [0]);
    expect(b0[1]).toBeCloseTo(2, 2);
    expect(Math.abs(b1[1])).toBeLessThan(Math.abs(b0[1]));
    // Intercept must still be penalized-free: with only intercept penalized-free,
    // the fit should recover slope ~2 at very low lambda.
    expect(b0[0]).toBeCloseTo(0, 2);
  });

  it("recovers OLS at lambda ~ 0 for full-rank X", () => {
    // 3 samples, 2 features (with intercept)
    const X = [[1, 1, 3], [1, 2, 1], [1, 4, 5]];
    const yTrue = [1 * 1 + 3 * 2, 1 * 2 + 3 * 1, 1 * 4 + 3 * 5].map((v) => v + 1); // intercept=1
    const beta = ridgeSolve(X, yTrue, 1e-8, [0]);
    // predict back exactly
    for (let i = 0; i < X.length; i++) expect(predict(X[i], beta)).toBeCloseTo(yTrue[i], 4);
  });

  it("matmulATA is symmetric", () => {
    const X = [[1, 2, 3], [4, 5, 6], [7, 8, 9], [1, 0, 1]];
    const A = matmulATA(X);
    for (let i = 0; i < A.length; i++) for (let j = 0; j < A.length; j++) expect(A[i][j]).toBe(A[j][i]);
  });
});
