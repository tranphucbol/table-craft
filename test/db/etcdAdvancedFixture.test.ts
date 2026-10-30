import { describe, expect, it } from "vitest";
import {
  ISOLATED_ETCD_IMAGES,
  isolatedEtcdCleanupCommands,
  isolatedEtcdSetupCommands,
  planIsolatedEtcd,
} from "../support/etcdIsolated.js";

const PORTS = [41321, 41322, 41323];
const ID = "fixture-self-test";
const SMALL_QUOTA_BYTES = 2 * 1024 * 1024;

describe("isolated etcd fixture planning (no Docker)", () => {
  it.each(["3.5", "3.6"] as const)(
    "givenVersion%s_whenPlanningSingleMember_thenPinnedImageAndLoopbackClient",
    (version) => {
      const plan = planIsolatedEtcd({ version, quotaBytes: SMALL_QUOTA_BYTES }, [PORTS[0]!], ID);
      const commands = isolatedEtcdSetupCommands(plan);
      const member = plan.members[0]!;
      const run = commands.find((command) => command.includes(member.name) && command.includes("--publish"))!;
      expect(plan.image).toBe(ISOLATED_ETCD_IMAGES[version]);
      expect(run).toContain(`127.0.0.1:${String(PORTS[0])}:2379`);
      expect(run).toContain(`--advertise-client-urls=${member.endpoint}`);
      expect(run).toContain(`--initial-advertise-peer-urls=${member.peerEndpoint}`);
      expect(run).toContain(`--quota-backend-bytes=${String(SMALL_QUOTA_BYTES)}`);
      expect(run).toContain("--pull=never");
      expect(run).not.toContain("--rm");
    },
  );

  it("givenThreeMembers_whenPlanning_thenPeersUseDedicatedNetworkDnsNotHostLoopback", () => {
    const plan = planIsolatedEtcd({ members: 3 }, PORTS, ID);
    const commands = isolatedEtcdSetupCommands(plan);
    const cluster = plan.members.map((member) => `${member.name}=${member.peerEndpoint}`).join(",");
    const runs = commands.filter((command) => command.includes("--publish"));
    expect(runs).toHaveLength(3);
    expect(commands[0]).toEqual(["network", "create", plan.network]);
    for (const [index, member] of plan.members.entries()) {
      expect(member.peerEndpoint).toBe(`http://${member.name}:2380`);
      expect(member.internalEndpoint).toBe(`http://${member.name}:2379`);
      expect(runs[index]).toContain(`--initial-cluster=${cluster}`);
      expect(runs[index]).toContain(plan.network);
      expect(runs[index]).toContain(`type=volume,src=${member.volume},dst=/var/lib/etcd`);
    }
  });

  it("givenRestartableMembers_whenPlanningStorage_thenKeeperRetainsEveryRamVolumeWithoutHostMounts", () => {
    const plan = planIsolatedEtcd({ members: 3 }, PORTS, ID);
    const commands = isolatedEtcdSetupCommands(plan);
    const keeper = commands.find((command) => command.includes(plan.keeper))!;
    for (const member of plan.members) {
      expect(commands).toContainEqual(expect.arrayContaining(["volume", "create", "type=tmpfs", member.volume]));
      expect(keeper).toContain(`type=volume,src=${member.volume},dst=/hold/${member.name}`);
    }
    expect(commands.flat().some((arg) => arg.includes("type=bind"))).toBe(false);
    expect(keeper).not.toContain("--publish");
  });

  it("givenPartialSetup_whenCleaning_thenAllMembersBeforeKeeperBeforeVolumesBeforeNetwork", () => {
    const plan = planIsolatedEtcd({ members: 3 }, PORTS, ID);
    expect(isolatedEtcdCleanupCommands(plan)).toEqual([
      ...plan.members.map((member) => ["rm", "--force", member.name]),
      ["rm", "--force", plan.keeper],
      ...plan.members.map((member) => ["volume", "rm", member.volume]),
      ["network", "rm", plan.network],
    ]);
  });

  it("givenConcurrentPlans_whenUsingDefaultIdentity_thenNamesDoNotOverlap", () => {
    const first = planIsolatedEtcd({}, [PORTS[0]!]);
    const second = planIsolatedEtcd({}, [PORTS[0]!]);
    expect(first.network).not.toBe(second.network);
    expect(first.members[0]!.volume).not.toBe(second.members[0]!.volume);
    expect(first.members[0]!.name.length).toBeLessThanOrEqual(63);
  });

  it("givenUnsafePlanningInputs_whenPlanning_thenRejectBeforeAnyDockerCommand", () => {
    expect(() => planIsolatedEtcd({}, [0], ID)).toThrow("host port");
    expect(() => planIsolatedEtcd({ members: 3 }, [41321, 41321, 41322], ID)).toThrow("host port");
    expect(() => planIsolatedEtcd({}, [PORTS[0]!], "../shared")).toThrow("suffix");
    expect(() => planIsolatedEtcd({}, [PORTS[0]!], "a".repeat(40))).toThrow("suffix");
    expect(() => planIsolatedEtcd({ quotaBytes: 1 }, [PORTS[0]!], ID)).toThrow("quota");
  });
});
