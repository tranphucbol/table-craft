import { runPluginContract } from "@table-craft/plugin-api/testing";
import duckdb from "@table-craft/plugin-duckdb";
import { duckdbContractFixture, seededDuckdbFiles } from "../support/duckdbFixture.js";
import { DUCKDB_MANIFEST } from "../support/manifests.js";

runPluginContract(duckdb, duckdbContractFixture(DUCKDB_MANIFEST, await seededDuckdbFiles()));
