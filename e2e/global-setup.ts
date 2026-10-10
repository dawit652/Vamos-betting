import { assertStackUp } from './support/stack';

/** Fails fast, with the start-up commands, when the stack under test is not running. */
export default async function globalSetup(): Promise<void> {
  await assertStackUp();
}
