import { getPackageName } from './parse';
import { getHoistingDecision, finalizeDependedDecisions, Hoistable, HoistingDecision } from './decision';
import { getChildren, getPriorities, getUsages, HoistingPriorities } from './priority';

export type HoistingOptions = {
  trace?: boolean;
  check?: CheckType;
  explain?: boolean;
};

type Route = Array<{ depName: PackageName; isWorkspaceDep: boolean }>;

export type PackageId = string & { _packageId: true };
export type PackageName = string & { _packageName: true };
export enum PackageType {
  PORTAL = 'PORTAL',
}

export enum CheckType {
  THOROUGH = 'THOROUGH',
  FINAL = 'FINAL',
}

export const PackageId = {
  root: '.' as PackageId,
};

export type Graph = {
  id: string;
  tags?: Record<string, string[]>;
  alias?: string;
  dependencies?: Graph[];
  workspaces?: Graph[];
  peerNames?: string[];
  packageType?: PackageType;
  wall?: string[];
  reason?: string;
};

export type WorkGraph = {
  id: PackageId;
  tags?: Map<string, Set<string>>;
  dependencies?: Map<PackageName, WorkGraph>;
  lookupUsages?: Map<WorkGraph, Set<PackageName>>;
  lookupDependants?: Map<PackageName, Set<WorkGraph>>;
  workspaces?: Map<PackageName, WorkGraph>;
  peerNames?: Map<PackageName, Route | null>;
  packageType?: PackageType;
  priority?: number;
  wall?: Set<PackageName>;
  originalParent?: WorkGraph;
  newParent?: WorkGraph;
  reason?: string;
};

const decoupleNode = (node: WorkGraph): WorkGraph => {
  if (node['__decoupled']) return node;

  const clone: WorkGraph = { id: node.id };

  if (node.packageType) {
    clone.packageType = node.packageType;
  }

  if (node.peerNames) {
    clone.peerNames = new Map(node.peerNames);
  }

  if (node.tags) {
    clone.tags = new Map(node.tags);
  }

  if (node.wall) {
    clone.wall = node.wall;
  }

  if (node.workspaces) {
    clone.workspaces = new Map(node.workspaces);
  }

  if (node.dependencies) {
    clone.dependencies = new Map(node.dependencies);
    const nodeName = getPackageName(node.id);
    const selfNameDep = node.dependencies.get(nodeName);
    if (selfNameDep === node) {
      clone.dependencies.set(nodeName, clone);
    }
  }

  Object.defineProperty(clone, '__decoupled', { value: true });

  return clone;
};

const getAliasedId = (pkg: Graph): PackageId =>
  !pkg.alias ? (pkg.id as PackageId) : (`${pkg.alias}@>${pkg.id}` as PackageId);

const fromAliasedId = (aliasedId: PackageId): { alias?: PackageName; id: PackageId } => {
  const alias = getPackageName(aliasedId);
  const idIndex = aliasedId.indexOf('@>', alias.length);
  return idIndex < 0 ? { id: aliasedId } : { alias, id: aliasedId.substring(idIndex + 2) as PackageId };
};

const populateImplicitPeers = (graph: WorkGraph) => {
  const seen = new Set();

  const visitDependency = (graphPath: { node: WorkGraph; isWorkspaceDep: boolean }[]) => {
    const node = graphPath[graphPath.length - 1].node;
    const isSeen = seen.has(node);
    seen.add(node);

    if (node.peerNames && graphPath.length > 1) {
      const parent = graphPath[graphPath.length - 2];
      for (const [peerName, route] of node.peerNames) {
        if (route === null && !parent.node.dependencies?.has(peerName) && !parent.node.peerNames?.has(peerName)) {
          const route: Route = [
            {
              depName: getPackageName(node.id),
              isWorkspaceDep: graphPath[graphPath.length - 1].isWorkspaceDep,
            },
          ];
          for (let idx = graphPath.length - 2; idx >= 0; idx--) {
            const parent = graphPath[idx];
            if (parent.node.dependencies?.has(peerName)) {
              for (let j = idx + 1; j < graphPath.length - 1; j++) {
                const peerNode = graphPath[j].node;
                if (!peerNode.peerNames) {
                  peerNode.peerNames = new Map();
                }
                if (!peerNode.peerNames.has(peerName)) {
                  peerNode.peerNames.set(peerName, route);
                }
              }
              break;
            } else {
              route.unshift({ depName: getPackageName(parent.node.id), isWorkspaceDep: parent.isWorkspaceDep });
            }
          }
        }
      }
    }

    if (!isSeen) {
      if (node.workspaces) {
        for (const dep of node.workspaces.values()) {
          graphPath.push({ node: dep, isWorkspaceDep: true });
          visitDependency(graphPath);
          graphPath.pop();
        }
      }

      if (node.dependencies) {
        for (const dep of node.dependencies.values()) {
          graphPath.push({ node: dep, isWorkspaceDep: true });
          visitDependency(graphPath);
          graphPath.pop();
        }
      }
    }
  };

  visitDependency([{ node: graph, isWorkspaceDep: true }]);
};

export const toWorkGraph = (rootPkg: Graph): WorkGraph => {
  const graph: WorkGraph = {
    id: getAliasedId(rootPkg),
  };

  Object.defineProperty(graph, '__decoupled', { value: true });

  const seen = new Map<Graph, WorkGraph>();

  const visitDependency = (pkg: Graph, parentNode: WorkGraph, { isWorkspaceDep }: { isWorkspaceDep: boolean }) => {
    const aliasedId = getAliasedId(pkg);
    const seenNode = seen.get(pkg);
    const newNode = pkg === rootPkg ? graph : seenNode || { id: aliasedId };
    seen.set(pkg, newNode);

    if (pkg.packageType) {
      newNode.packageType = pkg.packageType;
    }

    if (pkg.peerNames) {
      newNode.peerNames = new Map();
      for (const peerName of pkg.peerNames) {
        newNode.peerNames.set(peerName as PackageName, null);
      }
    }

    if (pkg.tags) {
      newNode.tags = new Map();
      for (const [key, tags] of Object.entries(pkg.tags)) {
        newNode.tags.set(key, new Set(tags));
      }
    }

    if (pkg.wall) {
      newNode.wall = new Set(pkg.wall as PackageName[]);
    }

    if (pkg !== rootPkg) {
      const name = getPackageName(newNode.id);
      if (isWorkspaceDep) {
        parentNode.workspaces = parentNode.workspaces || new Map();
        parentNode.workspaces.set(name, newNode);
      } else {
        parentNode.dependencies = parentNode.dependencies || new Map();
        parentNode.dependencies.set(name, newNode);
      }
    }

    if (!seenNode) {
      for (const workspaceDep of pkg.workspaces || []) {
        visitDependency(workspaceDep, newNode, { isWorkspaceDep: true });
      }

      for (const dep of pkg.dependencies || []) {
        visitDependency(dep, newNode, { isWorkspaceDep: false });
      }
    }
  };

  visitDependency(rootPkg, graph, { isWorkspaceDep: true });

  return graph;
};

const fromWorkGraph = (graph: WorkGraph): Graph => {
  const rootPkg: Graph = { id: fromAliasedId(graph.id).id };

  const visitDependency = (
    graphPath: WorkGraph[],
    parentPkg: Graph,
    { isWorkspaceDep }: { isWorkspaceDep: boolean }
  ) => {
    const node = graphPath[graphPath.length - 1];
    let newPkg;
    if (graphPath.length === 1) {
      newPkg = parentPkg;
    } else {
      const { alias, id } = fromAliasedId(node.id);
      newPkg = { id };
      if (alias) {
        newPkg.alias = alias;
      }
    }

    if (node.packageType) {
      newPkg.packageType = node.packageType;
    }

    if (node.peerNames) {
      for (const [peerName, route] of node.peerNames) {
        if (route === null) {
          if (!newPkg.peerNames) {
            newPkg.peerNames = [];
          }
          newPkg.peerNames.push(peerName);
        }
      }
    }

    if (node.reason) {
      newPkg.reason = node.reason;
    }

    if (node.tags) {
      newPkg.tags = {};
      const keys = Array.from(node.tags.keys()).sort();
      for (const key of keys) {
        newPkg.tags[key] = Array.from(node.tags.get(key)!).sort();
      }
    }

    if (node.wall) {
      newPkg.wall = Array.from(node.wall).sort();
    }

    if (graphPath.length > 1) {
      if (isWorkspaceDep) {
        parentPkg.workspaces = parentPkg.workspaces || [];
        parentPkg.workspaces.push(newPkg);
      } else {
        parentPkg.dependencies = parentPkg.dependencies || [];
        parentPkg.dependencies.push(newPkg);
      }
    }

    if (graphPath.indexOf(node) === graphPath.length - 1) {
      if (node.workspaces) {
        const sortedEntries = Array.from(node.workspaces.entries()).sort((x1, x2) =>
          x1[0] === x2[0] ? 0 : x1[0] < x2[0] ? -1 : 1
        );

        for (const [, depWorkspace] of sortedEntries) {
          graphPath.push(depWorkspace);
          visitDependency(graphPath, newPkg, { isWorkspaceDep: true });
          graphPath.pop();
        }
      }

      if (node.dependencies) {
        const sortedEntries = Array.from(node.dependencies.entries()).sort((x1, x2) =>
          x1[0] === x2[0] ? 0 : x1[0] < x2[0] ? -1 : 1
        );

        for (const [, dep] of sortedEntries) {
          if (!dep.newParent || dep.newParent === node) {
            graphPath.push(dep);
            visitDependency(graphPath, newPkg, { isWorkspaceDep: false });
            graphPath.pop();
          }
        }
      }
    }
  };

  visitDependency([graph], rootPkg, { isWorkspaceDep: true });

  return rootPkg;
};

type QueueElement = { graphPath: WorkGraph[]; priorityArray: HoistingPriorities[]; depName: PackageName };
type HoistingQueue = Array<QueueElement[]>;

const hoistDependencies = (
  graphPath: WorkGraph[],
  priorityArray: HoistingPriorities[],
  currentPriorityDepth: number,
  depNames: Set<PackageName>,
  options: HoistingOptions,
  hoistingQueue: HoistingQueue
): boolean => {
  let wasGraphChanged = false;
  const parentPkg = graphPath[graphPath.length - 1];

  const preliminaryDecisionMap = new Map<PackageName, HoistingDecision>();
  for (const depName of depNames) {
    preliminaryDecisionMap.set(depName, getHoistingDecision(graphPath, depName, priorityArray, currentPriorityDepth));
  }

  if (options.trace) {
    console.log(
      currentPriorityDepth === 0 ? 'visit' : 'revisit',
      graphPath.map((x) => x.id)
    );
  }

  const finalDecisions = finalizeDependedDecisions(preliminaryDecisionMap, options);

  const hoistDependency = (dep: WorkGraph, depName: PackageName, newParentIndex: number) => {
    delete dep.priority;
    const rootPkg = graphPath[newParentIndex];
    for (let idx = newParentIndex; idx < graphPath.length - 1; idx++) {
      const pkg = graphPath[idx];
      const rootPkgDep = pkg.dependencies!.get(depName);
      if (!rootPkgDep) {
        pkg.dependencies!.set(depName, dep);
      }

      if (rootPkgDep && dep.tags) {
        rootPkgDep.tags = rootPkgDep.tags || new Map();
        for (const [key, tags] of dep.tags) {
          let rootDepTags = rootPkgDep.tags.get(key);
          if (!rootDepTags) {
            rootDepTags = new Set<string>();
            rootPkgDep.tags.set(key, rootDepTags);
          }

          for (const tag of tags) {
            rootDepTags.add(tag);
          }
        }
      }

      if (!pkg.lookupUsages) {
        pkg.lookupUsages = new Map();
      }

      let lookupNameList = pkg.lookupUsages.get(parentPkg);
      if (!lookupNameList) {
        lookupNameList = new Set();
        pkg.lookupUsages.set(parentPkg, lookupNameList);
      }
      lookupNameList.add(depName);

      if (!pkg.lookupDependants) {
        pkg.lookupDependants = new Map();
      }

      let dependantList = pkg.lookupDependants.get(depName);
      if (!dependantList) {
        dependantList = new Set();
        pkg.lookupDependants.set(depName, dependantList);
      }
      dependantList.add(parentPkg);
    }
    dep.newParent = rootPkg;

    for (let idx = newParentIndex + 1; idx < graphPath.length; idx++) {
      const pkg = graphPath[idx];
      if (pkg.lookupUsages) {
        const depLookupNames = pkg.lookupUsages.get(dep);
        if (depLookupNames) {
          for (const name of depLookupNames) {
            const dependantList = pkg.lookupDependants!.get(name)!;
            dependantList.delete(dep);
            if (dependantList.size === 0) {
              pkg.lookupDependants!.delete(name);
              const pkgDep = pkg.dependencies!.get(name)!;
              // Delete "lookup" dependency, because of empty set of dependants
              if (pkgDep!.newParent && pkgDep!.newParent !== pkg) {
                if (options.trace) {
                  console.log(
                    `clearing previous lookup dependency by ${dep.id} on ${pkgDep.id} in`,
                    graphPath.slice(0, idx + 1).map((x) => x.id)
                  );
                }
                pkg.dependencies!.delete(name);
              }
            }
          }
        }
        pkg.lookupUsages.delete(dep);
      }
    }

    if (options.trace) {
      console.log(
        graphPath.map((x) => x.id),
        'hoist',
        dep.id,
        'into',
        rootPkg.id,
        `result:\n${print(graphPath[0])}`
      );
    }
  };

  if (finalDecisions.circularPackageNames.size > 0) {
    for (const depName of finalDecisions.circularPackageNames) {
      const dep = parentPkg.dependencies!.get(depName)!;
      const decision = finalDecisions.decisionMap.get(depName)!;
      if (decision.isHoistable === Hoistable.DEPENDS) {
        if (dep.newParent !== graphPath[decision.newParentIndex]) {
          hoistDependency(dep, depName, decision.newParentIndex);
          wasGraphChanged = true;
        }
      }
    }

    if (options.check === CheckType.THOROUGH) {
      const log = checkContracts(graphPath[0]);
      if (log) {
        console.log(
          `Contracts violated after hoisting ${Array.from(finalDecisions.circularPackageNames)} from ${printGraphPath(
            graphPath
          )}\n${log}${print(graphPath[0])}`
        );
      }
    }
  }

  for (const depName of finalDecisions.decisionMap.keys()) {
    const dep = parentPkg.dependencies!.get(depName)!;
    const decision = finalDecisions.decisionMap.get(depName)!;
    if (decision.isHoistable === Hoistable.YES && decision.newParentIndex !== graphPath.length - 1) {
      if (dep.newParent !== graphPath[decision.newParentIndex]) {
        hoistDependency(dep, depName, decision.newParentIndex);
        wasGraphChanged = true;

        if (options.check === CheckType.THOROUGH) {
          const log = checkContracts(graphPath[0]);
          if (log) {
            throw new Error(
              `Contracts violated after hoisting ${depName} from ${printGraphPath(graphPath)}\n${log}${print(
                graphPath[0]
              )}`
            );
          }
        }
      }
    } else if (decision.isHoistable === Hoistable.LATER) {
      if (options.trace) {
        console.log(
          'queue',
          graphPath.map((x) => x.id).concat([dep.id]),
          'to depth:',
          decision.priorityDepth,
          'cur depth:',
          currentPriorityDepth
        );
      }
      dep.priority = decision.priorityDepth;

      hoistingQueue![decision.priorityDepth].push({
        graphPath: graphPath.slice(0),
        priorityArray: priorityArray.slice(0),
        depName,
      });
    } else {
      if (options.explain && decision.reason) {
        dep.reason = decision.reason;
      }
      delete dep.priority;
    }
  }

  return wasGraphChanged;
};

const hoistGraph = (graph: WorkGraph, options: HoistingOptions): boolean => {
  let wasGraphChanged = false;

  if (options.trace) {
    console.log(`original graph:\n${print(graph)}`);
  }

  if (options.check) {
    const log = checkContracts(graph);
    if (log) {
      throw new Error(`Contracts violated on initial graph:\n${log}${print(graph)}`);
    }
  }

  const usages = getUsages(graph);
  const children = getChildren(graph);
  const priorities = getPriorities(usages, children);

  if (options.trace) {
    console.log(`priorities at ${printGraphPath([graph])}: ${require('util').inspect(priorities, false, null)}`);
  }

  const workspaceIds = new Set<PackageId>();
  const visitWorkspace = (workspace: WorkGraph) => {
    workspaceIds.add(workspace.id);
    if (workspace.workspaces) {
      for (const dep of workspace.workspaces.values()) {
        visitWorkspace(dep);
      }
    }
  };
  visitWorkspace(graph);

  let maxPriorityDepth = 0;
  for (const priorityIds of priorities.values()) {
    maxPriorityDepth = Math.max(maxPriorityDepth, priorityIds.length);
  }
  const hoistingQueue: HoistingQueue = [];
  for (let idx = 0; idx < maxPriorityDepth; idx++) {
    hoistingQueue.push([]);
  }
  let priorityDepth = 0;

  const visitParent = (graphPath: WorkGraph[], priorityArray: HoistingPriorities[]) => {
    const node = graphPath[graphPath.length - 1];

    if (node.dependencies) {
      for (const [depName, dep] of node.dependencies) {
        const newDep = decoupleNode(dep);
        newDep.originalParent = node;
        node.dependencies!.set(depName, newDep);
      }
    }

    if (node.workspaces) {
      for (const [workspaceName, workspaceDep] of node.workspaces) {
        const newDep = decoupleNode(workspaceDep);
        newDep.originalParent = node;
        node.workspaces!.set(workspaceName, newDep);
      }
    }

    if (graphPath.length > 1 && node.dependencies) {
      const dependencies = new Set<PackageName>();
      for (const [depName, dep] of node.dependencies) {
        if (!dep.newParent || dep.newParent === node) {
          dependencies.add(depName);
        }
      }

      if (dependencies.size > 0) {
        if (hoistDependencies(graphPath, priorityArray, priorityDepth, dependencies, options, hoistingQueue)) {
          wasGraphChanged = true;
        }
      }
    }

    if (graphPath.indexOf(node) === graphPath.length - 1) {
      if (node.workspaces) {
        for (const depWorkspace of node.workspaces.values()) {
          const depPriorities = getPriorities(usages, getChildren(depWorkspace));
          graphPath.push(depWorkspace);
          if (options.trace) {
            console.log(
              `priorities at ${printGraphPath(graphPath)}: ${require('util').inspect(depPriorities, false, null)}`
            );
          }
          priorityArray.push(depPriorities);
          visitParent(graphPath, priorityArray);
          priorityArray.pop();
          graphPath.pop();
        }
      }

      if (node.dependencies) {
        for (const dep of node.dependencies.values()) {
          if (dep.id !== node.id && !workspaceIds.has(dep.id) && (!dep.newParent || dep.newParent === node)) {
            const depPriorities = getPriorities(usages, getChildren(dep));
            graphPath.push(dep);
            if (options.trace) {
              console.log(
                `priorities at ${printGraphPath(graphPath)}: ${require('util').inspect(depPriorities, false, null)}`
              );
            }
            priorityArray.push(depPriorities);
            visitParent(graphPath, priorityArray);
            priorityArray.pop();
            graphPath.pop();
          }
        }
      }
    }
  };

  visitParent([graph], [priorities]);

  for (priorityDepth = 1; priorityDepth < maxPriorityDepth; priorityDepth++) {
    while (hoistingQueue[priorityDepth].length > 0) {
      const queueElement = hoistingQueue[priorityDepth].shift()!;
      const graphPath: WorkGraph[] = [];
      const priorityArray: HoistingPriorities[] = [];
      let node: WorkGraph | undefined = queueElement.graphPath[queueElement.graphPath.length - 1];
      do {
        graphPath.unshift(node);
        const idx = queueElement.graphPath.indexOf(node);
        priorityArray.unshift(queueElement.priorityArray[idx]);
        node = node.newParent || node.originalParent;
      } while (node);

      if (
        hoistDependencies(
          graphPath,
          priorityArray,
          priorityDepth,
          new Set([queueElement.depName]),
          options,
          hoistingQueue
        )
      ) {
        wasGraphChanged = true;
      }
    }
  }

  if (options.check === CheckType.FINAL) {
    const log = checkContracts(graph);
    if (log) {
      throw new Error(`Contracts violated after hoisting finished:\n${log}${print(graph)}`);
    }
  }

  return wasGraphChanged;
};

const cloneWorkGraph = (graph: WorkGraph): WorkGraph => {
  const clonedNodes = new Map<WorkGraph, WorkGraph>();

  const cloneDependency = (node: WorkGraph) => {
    let clonedNode = clonedNodes.get(node);

    if (!clonedNode) {
      clonedNode = Object.assign({}, node);
      if (node['__decoupled']) {
        Object.defineProperty(clonedNode, '__decoupled', { value: true });
      }

      delete clonedNode.priority;
      clonedNodes.set(node, clonedNode);

      if (node.workspaces) {
        for (const dep of node.workspaces.values()) {
          cloneDependency(dep);
        }
      }

      if (node.dependencies) {
        for (const dep of node.dependencies.values()) {
          cloneDependency(dep);
        }
      }
    }

    return clonedNode;
  };

  const clonedGraph = cloneDependency(graph);

  for (const node of clonedNodes.values()) {
    if (node.originalParent) {
      node.originalParent = clonedNodes.get(node.originalParent);
    }

    if (node.newParent) {
      node.newParent = clonedNodes.get(node.newParent);
    }

    if (node.dependencies) {
      const newDependencies = new Map();
      for (const [depName, dep] of node.dependencies) {
        newDependencies.set(depName, clonedNodes.get(dep)!);
      }
      node.dependencies = newDependencies;
    }

    if (node.workspaces) {
      const newWorkspaces = new Map();
      for (const [depName, dep] of node.workspaces) {
        newWorkspaces.set(depName, clonedNodes.get(dep)!);
      }
      node.workspaces = newWorkspaces;
    }

    if (node.lookupDependants) {
      const newLookupDependants = new Map();
      for (const [depName, originalUsedBySet] of node.lookupDependants) {
        const usedBySet = new Set<WorkGraph>();
        for (const dep of originalUsedBySet) {
          usedBySet.add(clonedNodes.get(dep)!);
        }
        newLookupDependants.set(depName, usedBySet);
      }
      node.lookupDependants = newLookupDependants;
    }

    if (node.lookupUsages) {
      const newLookupUsages = new Map();
      for (const [dependant, value] of node.lookupUsages) {
        newLookupUsages.set(clonedNodes.get(dependant)!, value);
      }
      node.lookupUsages = newLookupUsages;
    }
  }

  return clonedGraph;
};

export const hoist = (pkg: Graph, opts?: HoistingOptions): Graph => {
  const graph = toWorkGraph(pkg);
  const options = opts || { trace: false };

  populateImplicitPeers(graph);
  hoistGraph(graph, options);
  if (options.check) {
    if (options.trace) {
      console.log('second pass');
    }

    const secondGraph = cloneWorkGraph(graph);
    let wasGraphChanged = false;
    try {
      wasGraphChanged = hoistGraph(secondGraph, options);
    } catch (e) {
      const error = new Error('While checking for terminal result. ' + (e as any).message);
      error.stack += (e as any).stack;
      throw error;
    }
    if (wasGraphChanged) {
      throw new Error(
        `Hoister produced non-terminal result\nFirst graph:\n${print(graph)}\n\nSecond graph:\n${print(secondGraph)}`
      );
    }
  }

  if (options.trace) {
    console.log(`final hoisted graph:\n${print(graph)}`);
  }

  return fromWorkGraph(graph);
};

const getOriginalGrapPath = (node: WorkGraph): WorkGraph[] => {
  const graphPath: WorkGraph[] = [];

  let pkg: WorkGraph | undefined = node;
  do {
    if (pkg) {
      graphPath.unshift(pkg);
      pkg = pkg.originalParent;
    }
  } while (pkg);

  return graphPath;
};

const getLatestGrapPath = (node: WorkGraph): WorkGraph[] => {
  const graphPath: WorkGraph[] = [];

  let pkg: WorkGraph | undefined = node;
  do {
    if (pkg) {
      graphPath.unshift(pkg);
      pkg = pkg.newParent || pkg.originalParent;
    }
  } while (pkg);

  return graphPath;
};

export const printGraphPath = (graphPath: WorkGraph[]): string => graphPath.map((x) => x.id).join('➣');

const checkContracts = (graph: WorkGraph): string => {
  const seen = new Set();
  const checkParent = (graphPath: WorkGraph[]): string => {
    const node = graphPath[graphPath.length - 1];
    const isSeen = seen.has(node);
    seen.add(node);

    let log = '';

    if (node.dependencies) {
      for (const [depName, dep] of node.dependencies) {
        const originalDep = dep.originalParent?.dependencies?.get(depName);
        if (originalDep) {
          let actualDep;
          for (let idx = graphPath.length - 1; idx >= 0; idx--) {
            const nodeDep = graphPath[idx]?.dependencies?.get(depName);
            if (nodeDep && (nodeDep.newParent || nodeDep.originalParent) == graphPath[idx]) {
              actualDep = nodeDep;
              break;
            }
          }

          if (actualDep?.id !== originalDep.id) {
            log += `Expected ${originalDep.id} at ${printGraphPath(graphPath)}, but found: ${actualDep?.id || 'none'}`;
            if (actualDep?.newParent) {
              log += ` previously hoisted from ${printGraphPath(getOriginalGrapPath(actualDep))}`;
            }
            log += `\n`;
          }
        }
      }
    }

    if (node.peerNames) {
      const originalGraphPath = getOriginalGrapPath(node);
      for (const peerName of node.peerNames.keys()) {
        let originalPeerDep;
        for (let idx = originalGraphPath.length - 2; idx >= 0; idx--) {
          const nodeDep = originalGraphPath[idx].dependencies?.get(peerName);
          if (nodeDep?.originalParent == originalGraphPath[idx]) {
            originalPeerDep = nodeDep;
            break;
          }
        }

        if (originalPeerDep) {
          let actualPeerDep;
          for (let idx = graphPath.length - 2; idx >= 0; idx--) {
            const nodeDep = graphPath[idx].dependencies?.get(peerName);
            if (nodeDep && (nodeDep.newParent || nodeDep.originalParent) == graphPath[idx]) {
              actualPeerDep = nodeDep;
              break;
            }
          }

          if (actualPeerDep !== originalPeerDep) {
            log += `Expected peer dependency ${originalPeerDep.id} at ${printGraphPath(graphPath)}, but found: ${
              actualPeerDep?.id || 'none'
            } at ${printGraphPath(getLatestGrapPath(actualPeerDep))}`;
            if (actualPeerDep?.newParent) {
              log += ` previously hoisted from ${printGraphPath(getOriginalGrapPath(actualPeerDep))}`;
            }
            log += `\n`;
          }
        }
      }
    }

    if (!isSeen) {
      if (node.workspaces) {
        for (const dep of node.workspaces.values()) {
          graphPath.push(dep);
          log += checkParent(graphPath);
          graphPath.pop();
        }
      }

      if (node.dependencies) {
        for (const dep of node.dependencies.values()) {
          if ((dep.newParent || dep.originalParent) === node) {
            graphPath.push(dep);
            log += checkParent(graphPath);
            graphPath.pop();
          }
        }
      }
    }

    return log;
  };

  return checkParent([graph]);
};

const print = (graph: WorkGraph): string => {
  const printDependency = (
    graphPath: WorkGraph[],
    { prefix, depPrefix, isWorkspace }: { prefix: string; depPrefix: string; isWorkspace: boolean }
  ): string => {
    const node = graphPath[graphPath.length - 1];
    if (graphPath.indexOf(node) !== graphPath.length - 1) return '';

    let str = depPrefix;
    if (isWorkspace) {
      str += 'workspace:';
    } else if (node.packageType === PackageType.PORTAL) {
      str += 'portal:';
    }

    str += node.id;
    if (node.wall) {
      str += '|';
      if (node.wall.size > 0) {
        str += Array.from(node.wall);
      }
    }
    if (node.priority) {
      str += ` queue: ${node.priority}`;
    }
    if (node.reason) {
      str += ` - ${node.reason}`;
    }
    str += '\n';

    let deps: WorkGraph[] = [];
    let workspaceCount = 0;
    if (node.workspaces) {
      const workspaces = Array.from(node.workspaces.values());
      workspaceCount = workspaces.length;
      deps = deps.concat(workspaces);
    }

    if (node.dependencies) {
      deps = deps.concat(Array.from(node.dependencies.values()).filter((x) => !x.newParent || x.newParent === node));
    }
    deps.sort((d1, d2) => (d2.id < d1.id ? 1 : -1));

    for (let idx = 0; idx < deps.length; idx++) {
      const dep = deps[idx];
      graphPath.push(dep);
      const hasMoreDependencies = idx < deps.length - 1;
      str += printDependency(graphPath, {
        depPrefix: prefix + (hasMoreDependencies ? `├─` : `└─`),
        prefix: prefix + (hasMoreDependencies ? `│ ` : `  `),
        isWorkspace: idx < workspaceCount,
      });
      graphPath.pop();
    }

    return str;
  };

  return printDependency([graph], { prefix: '  ', depPrefix: '', isWorkspace: true }).trim();
};
