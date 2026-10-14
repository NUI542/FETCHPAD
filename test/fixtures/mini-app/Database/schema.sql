-- Fixture schema
CREATE TABLE IF NOT EXISTS owners (
    id    SERIAL PRIMARY KEY,
    name  VARCHAR(100) NOT NULL
);

CREATE TABLE IF NOT EXISTS things (
    id          SERIAL PRIMARY KEY,
    name        TEXT        NOT NULL UNIQUE,
    owner_id    INT         REFERENCES owners(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tags (
    id        SERIAL PRIMARY KEY,
    thing_id  INT NOT NULL,
    label     TEXT NOT NULL,
    CONSTRAINT fk_tags_thing FOREIGN KEY (thing_id) REFERENCES things(id)
);
