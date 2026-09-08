ALTER TABLE nodes ADD COLUMN icon TEXT CHECK(icon IS NULL OR icon IN ('diamond','briefcase','target','folder','archive','bookmark','list','checklist','calendar','flag'));
ALTER TABLE nodes ADD COLUMN color TEXT CHECK(color IS NULL OR color IN ('slate','orange','amber','green','teal','blue','violet','rose'));
