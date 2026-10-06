import type { NormalizedTransaction } from "./transaction-normalizer.js";

export interface InstructionTrace {
  readonly innerRoots: readonly number[];
  readonly innerParents: readonly string[];
  readonly rootReturns: ReadonlyMap<number, bigint>;
}

/** Match runtime invocation records to every captured instruction. User log
 * strings have a `Program log:` prefix and cannot supply these anchored records.
 * Incomplete, contradictory or truncated traces provide no attribution proof. */
export function verifiedInstructionTrace(
  transaction: NormalizedTransaction,
): InstructionTrace | undefined {
  const stack: string[] = [];
  const innerRoots: number[] = [];
  const innerParents: string[] = [];
  const rootReturns = new Map<number, bigint>();
  let outer = 0,
    inner = 0,
    root = -1;
  for (const line of transaction.logMessages) {
    const invoke = /^Program (\S+) invoke \[(\d+)\]$/.exec(line);
    if (invoke) {
      const program = invoke[1]!;
      const depth = Number(invoke[2]);
      if (depth !== stack.length + 1) return undefined;
      if (depth === 1) {
        if (transaction.outerInstructions[outer]?.programId !== program)
          return undefined;
        root = outer++;
      } else {
        if (transaction.innerInstructions[inner++]?.programId !== program)
          return undefined;
        innerRoots.push(root);
        innerParents.push(stack.at(-1)!);
      }
      stack.push(program);
      continue;
    }
    const success = /^Program (\S+) success$/.exec(line);
    if (success) {
      if (stack.pop() !== success[1]) return undefined;
      continue;
    }
    if (/^Program \S+ failed:/.test(line) || /Log truncated/i.test(line))
      return undefined;
    const returned = /^Program return: (\S+) ([A-Za-z0-9+/]+={0,2})$/.exec(
      line,
    );
    if (returned && stack.length === 1 && stack[0] === returned[1]) {
      const decoded = Buffer.from(returned[2]!, "base64");
      if (decoded.length === 8 && decoded.toString("base64") === returned[2]) {
        if (rootReturns.has(root)) return undefined;
        rootReturns.set(root, decoded.readBigUInt64LE());
      }
    }
  }
  if (
    stack.length ||
    outer !== transaction.outerInstructions.length ||
    inner !== transaction.innerInstructions.length
  )
    return undefined;
  return { innerRoots, innerParents, rootReturns };
}
