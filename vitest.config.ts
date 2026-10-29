import {defineConfig} from 'vitest/config'
// The SQL tests build a whole database from the migrations in PGlite (a few seconds each when
// files run in parallel), which the 5-second default does not allow for.
export default defineConfig({test:{testTimeout:60_000,hookTimeout:60_000}})
