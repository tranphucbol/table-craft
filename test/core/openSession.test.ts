import { describe, expect, it, vi } from "vitest";
import { openSession, type PluginLoadResult } from "@table-craft/core";
import { z, type Capability, type Session } from "@table-craft/plugin-api";
import { SILENT_COMMAND_LANGUAGE } from "../support/declaredServices.js";
import { fakeManifest } from "../support/manifests.js";

const PLUGIN_ID = "broken";
const OPTIONS = { readOnly: false };

function pluginReturning(capabilities: readonly Capability[], session: Session): PluginLoadResult {
  return {
    status: "loaded",
    directory: `plugins/${PLUGIN_ID}`,
    manifest: fakeManifest({ id: PLUGIN_ID, name: "Broken", capabilities: [...capabilities], highlight: "redis" }),
    plugin: {
      id: PLUGIN_ID,
      capabilities: [...capabilities],
      commandLanguage: SILENT_COMMAND_LANGUAGE,
      connectionSchema: z.object({}),
      connect: () => Promise.resolve(session),
    },
  };
}

function session(services: Session["services"], close: () => Promise<void>): Session {
  return { execute: () => Promise.reject(new Error("not used")), close, serverVersion: null, services };
}

describe("openSession", () => {
  it("givenSessionMissingDeclaredService_whenOpened_thenPluginUnavailableAndClosed", async () => {
    const close = vi.fn(() => Promise.resolve());
    const plugin = pluginReturning(["commands", "keepAlive"], session({}, close));

    await expect(openSession([plugin], PLUGIN_ID, {}, OPTIONS)).rejects.toMatchObject({
      code: "pluginUnavailable",
      message: `Plugin "${PLUGIN_ID}" is unavailable: it declares keepAlive but its session has no keepAlive service.`,
      hint: "Update the plugin, or report the problem to its author.",
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("givenSessionWithUndeclaredService_whenOpened_thenPluginUnavailable", async () => {
    const close = vi.fn(() => Promise.resolve());
    const keepAlive = { ping: () => Promise.resolve() };
    const plugin = pluginReturning(["commands"], session({ keepAlive }, close));

    await expect(openSession([plugin], PLUGIN_ID, {}, OPTIONS)).rejects.toMatchObject({
      code: "pluginUnavailable",
      message: `Plugin "${PLUGIN_ID}" is unavailable: it has the keepAlive service on its session but does not declare keepAlive.`,
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("givenSessionWhoseCloseRejects_whenRefused_thenStillPluginUnavailable", async () => {
    const close = vi.fn(() => Promise.reject(new Error("socket already gone")));
    const plugin = pluginReturning(["commands", "keepAlive"], session({}, close));

    await expect(openSession([plugin], PLUGIN_ID, {}, OPTIONS)).rejects.toMatchObject({ code: "pluginUnavailable" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("givenSessionWithExactlyDeclaredServices_whenOpened_thenReturned", async () => {
    const opened = session({ keepAlive: { ping: () => Promise.resolve() } }, () => Promise.resolve());
    const plugin = pluginReturning(["commands", "keepAlive"], opened);

    await expect(openSession([plugin], PLUGIN_ID, {}, OPTIONS)).resolves.toBe(opened);
  });
});
