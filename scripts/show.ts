// Print the tracker from Supabase. Run from the project root:  npm run show
import { closePools, readPool } from "../src/db/pool.js";

const { rows } = await readPool.query(
  `select c.name as company, a.role, a.status, a.applied_at
     from applications a join companies c on c.id = a.company_id
    where a.deleted_at is null
    order by a.applied_at desc nulls last`,
);
console.table(rows);
await closePools();
