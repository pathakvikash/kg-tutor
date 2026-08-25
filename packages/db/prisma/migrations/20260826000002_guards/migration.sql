-- Invariants deliberately enforced in SQL rather than application code: these are the
-- ones that corrupt data silently if a caller forgets them.

-- Decision 03: a hard edge is only meaningful with a named failure mode.
ALTER TABLE "Edge" ADD CONSTRAINT edge_hard_requires_failure_mode
  CHECK (
    "strength" <> 'hard'
    OR ("failureMode" IS NOT NULL AND length(btrim("failureMode")) > 0)
  );

-- Decision 13: the hard prerequisite graph must stay acyclic or the planner hangs.
-- Checked at write time so the invariant holds by construction, not by cleanup job.
CREATE OR REPLACE FUNCTION reject_hard_prerequisite_cycle() RETURNS trigger AS $$
BEGIN
  IF NEW."type" <> 'prerequisite_of'
     OR NEW."strength" <> 'hard'
     OR NEW."retiredAt" IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW."srcId" = NEW."dstId" THEN
    RAISE EXCEPTION 'hard prerequisite self-loop on %', NEW."srcId"
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    WITH RECURSIVE reach(id) AS (
      SELECT NEW."dstId"
      UNION
      SELECT e."dstId"
        FROM "Edge" e JOIN reach r ON e."srcId" = r.id
       WHERE e."type" = 'prerequisite_of'
         AND e."strength" = 'hard'
         AND e."retiredAt" IS NULL
    )
    SELECT 1 FROM reach WHERE id = NEW."srcId"
  ) THEN
    RAISE EXCEPTION 'hard prerequisite cycle: % -> %', NEW."srcId", NEW."dstId"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER edge_no_hard_cycle
  BEFORE INSERT OR UPDATE ON "Edge"
  FOR EACH ROW EXECUTE FUNCTION reject_hard_prerequisite_cycle();

-- Decision 05: sense is identity. Editing it in place silently moves what every
-- attached mastery record refers to.
CREATE OR REPLACE FUNCTION reject_sense_mutation() RETURNS trigger AS $$
BEGIN
  IF NEW."sense" IS DISTINCT FROM OLD."sense" THEN
    RAISE EXCEPTION 'Concept.sense is immutable (%); deprecate and relink instead', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER concept_sense_immutable
  BEFORE UPDATE ON "Concept"
  FOR EACH ROW EXECUTE FUNCTION reject_sense_mutation();

-- Resolver candidate generation (05) is an ANN query over (name + sense).
CREATE INDEX concept_sense_vector_idx ON "Concept"
  USING hnsw ("senseVector" vector_cosine_ops);
