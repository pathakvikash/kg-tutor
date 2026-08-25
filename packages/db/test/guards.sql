-- Repeatable proof that the invariant guards actually reject their violations.
-- Run:  docker exec -i kg-tutor-pg psql -U postgres -d kg_tutor -f - < packages/db/test/guards.sql
--
-- Expect: cases 1, 3, 4 and 6 ERROR; cases 2, 5 and 7 succeed. A silent pass on
-- 1, 3, 4 or 6 means an invariant has been lost.

BEGIN;

INSERT INTO "Concept" (id,"canonicalName",sense,"updatedAt") VALUES
 ('_g_a','functions','A named, reusable unit of computation.',now()),
 ('_g_b','closures','A function together with the scope it captured.',now()),
 ('_g_c','memoization','Caching a function''s results by its arguments.',now());

\echo '--- 1. hard edge without a failure mode: REJECT (03) ---'
SAVEPOINT s1;
INSERT INTO "Edge" (id,"srcId","dstId",type,strength,"updatedAt")
VALUES ('_g_e0','_g_a','_g_b','prerequisite_of','hard',now());
ROLLBACK TO s1;

\echo '--- 2. hard edge with a failure mode: ACCEPT ---'
INSERT INTO "Edge" (id,"srcId","dstId",type,strength,"failureMode","updatedAt") VALUES
 ('_g_e1','_g_a','_g_b','prerequisite_of','hard',
  'The learner reads an inner function as running immediately rather than being returned.',now()),
 ('_g_e2','_g_b','_g_c','prerequisite_of','hard',
  'The learner writes a cache that is recreated on every call, so nothing is ever reused.',now());

\echo '--- 3. hard cycle c -> a closing a->b->c: REJECT (13) ---'
SAVEPOINT s3;
INSERT INTO "Edge" (id,"srcId","dstId",type,strength,"failureMode","updatedAt")
VALUES ('_g_e3','_g_c','_g_a','prerequisite_of','hard','A concrete stated failure that passes the check.',now());
ROLLBACK TO s3;

\echo '--- 4. hard self-loop: REJECT ---'
SAVEPOINT s4;
INSERT INTO "Edge" (id,"srcId","dstId",type,strength,"failureMode","updatedAt")
VALUES ('_g_e4','_g_a','_g_a','prerequisite_of','hard','Another concrete stated failure mode here.',now());
ROLLBACK TO s4;

\echo '--- 5. soft edge closing the same cycle: ACCEPT (13) ---'
INSERT INTO "Edge" (id,"srcId","dstId",type,strength,"updatedAt")
VALUES ('_g_e5','_g_c','_g_a','related_to','soft',now());

\echo '--- 6. editing Concept.sense: REJECT (05) ---'
SAVEPOINT s6;
UPDATE "Concept" SET sense = 'something else entirely' WHERE id = '_g_b';
ROLLBACK TO s6;

\echo '--- 7. editing the mutable description: ACCEPT ---'
UPDATE "Concept" SET description = 'Teaching notes may change freely.' WHERE id = '_g_b';

ROLLBACK;
