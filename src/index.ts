import { getPackageName } from './parse';
import { getHoistPriorities, HoistPriorities } from './priority';

export type PackageId = string & { _packageId: true };
export type PackageName = string & { _packageName: true };
export enum PackageType {
  PORTAL,
}

export const PackageId = {
  root: '.' as PackageId,
};

export type Package = {
  id: PackageId;
  dependencies?: Package[];
  workspaces?: Package[];
  peerNames?: PackageName[];
  packageType?: PackageType;
};

export type Graph = {
  id: PackageId;
  dependencies?: Map<PackageName, Graph>;
  hoistedTo?: Map<PackageName, Graph>;
  workspaces?: Map<PackageName, Graph>;
  peerNames?: Set<PackageName>;
  packageType?: PackageType;
};

const EMPTY_MAP = new Map();

const decoupleNode = (graph: Graph): Graph => {
  if (graph['__decoupled']) return graph;

  const clone: Graph = { id: graph.id };

  if (graph.packageType) {
    clone.packageType = graph.packageType;
  }

  if (graph.peerNames) {
    clone.peerNames = new Set(graph.peerNames);
  }

  if (graph.workspaces) {
    clone.workspaces = new Map(graph.workspaces);
  }

  if (graph.dependencies) {
    clone.dependencies = new Map(graph.dependencies);
    const nodeName = getPackageName(graph.id);
    const selfNameDep = graph.dependencies.get(nodeName);
    if (selfNameDep === graph) {
      clone.dependencies.set(nodeName, clone);
    }
  }

  Object.defineProperty(clone, '__decoupled', { value: true });

  return clone;
};

export const toGraph = (rootPkg: Package): Graph => {
  const graph: Graph = {
    id: rootPkg.id,
  };

  const seen = new Set<Package>();

  const visitDependency = (
    pkg: Package,
    parentNode: Graph,
    parentNodes: Map<PackageId, Graph>,
    { isWorkspaceDep }: { isWorkspaceDep: boolean }
  ) => {
    const isSeen = seen.has(pkg);
    const newNode = pkg === rootPkg ? graph : parentNodes.get(pkg.id) || { id: pkg.id };
    seen.add(pkg);

    if (pkg.packageType) {
      newNode.packageType = pkg.packageType;
    }

    if (pkg.peerNames) {
      newNode.peerNames = new Set(pkg.peerNames);
    }

    if (pkg !== rootPkg) {
      const name = getPackageName(pkg.id);
      if (isWorkspaceDep) {
        parentNode.workspaces = parentNode.workspaces || new Map();
        parentNode.workspaces.set(name, newNode);
      } else {
        parentNode.dependencies = parentNode.dependencies || new Map();
        parentNode.dependencies.set(name, newNode);
      }
    }

    if (!isSeen) {
      const nextParentNodes = new Map([...parentNodes.entries(), [pkg.id, newNode]]);
      for (const workspaceDep of pkg.workspaces || []) {
        visitDependency(workspaceDep, newNode, nextParentNodes, { isWorkspaceDep: true });
      }

      for (const dep of pkg.dependencies || []) {
        visitDependency(dep, newNode, nextParentNodes, { isWorkspaceDep: false });
      }
    }
  };

  visitDependency(rootPkg, graph, new Map(), { isWorkspaceDep: true });

  // console.log(
  //   'pkg',
  //   require('util').inspect(rootPkg, false, null),
  //   'graph',
  //   require('util').inspect(graph, false, null)
  // );

  return graph;
};

export const toPackage = (graph: Graph): Package => {
  const rootPkg: Package = { id: graph.id };

  const visitDependency = (graphPath: Graph[], parentPkg: Package, { isWorkspaceDep }: { isWorkspaceDep: boolean }) => {
    const node = graphPath[graphPath.length - 1];
    const newPkg = graphPath.length === 1 ? parentPkg : { id: node.id };

    if (node.packageType) {
      newPkg.packageType = node.packageType;
    }

    if (node.peerNames) {
      newPkg.peerNames = Array.from(node.peerNames);
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
          graphPath.push(dep);
          visitDependency(graphPath, newPkg, { isWorkspaceDep: false });
          graphPath.pop();
        }
      }
    }
  };

  visitDependency([graph], rootPkg, { isWorkspaceDep: true });

  return rootPkg;
};

type QueueElement = { graphPath: PackageId[]; depName: PackageName };
type HoistQueue = Array<QueueElement[]>;

enum Hoistable {
  LATER,
  YES,
  NO,
  DEPENDS,
}

type HoistVerdict =
  | {
      isHoistable: Hoistable.LATER;
      priorityDepth: number;
    }
  | {
      isHoistable: Hoistable.YES;
      newParentIndex: number;
    }
  | {
      isHoistable: Hoistable.NO;
    }
  | {
      isHoistable: Hoistable.DEPENDS;
      dependsOn: Set<Graph>;
    };

const getHoistVerdict = (
  graphPath: Graph[],
  depName: PackageName,
  hoistPriorities: HoistPriorities,
  currentPriorityDepth: number
): HoistVerdict => {
  const parentPkg = graphPath[graphPath.length - 1];
  const dep = parentPkg.dependencies!.get(depName)!;
  const priorityIds = hoistPriorities.get(depName)!;
  let isHoistable = Hoistable.NO;
  let priorityDepth;
  let newParentIndex;

  // Check require promise
  for (newParentIndex = 0; newParentIndex < graphPath.length - 1; newParentIndex++) {
    const newParentPkg = graphPath[newParentIndex];

    const newParentDep = newParentPkg.dependencies?.get(depName);
    priorityDepth = priorityIds.indexOf(dep.id);
    const isDepTurn = priorityDepth === currentPriorityDepth;
    if (!newParentDep) {
      isHoistable = isDepTurn ? Hoistable.YES : Hoistable.LATER;
    } else {
      isHoistable = newParentDep.id === dep.id ? Hoistable.YES : Hoistable.NO;
    }

    if (isHoistable === Hoistable.YES) {
      for (const [hoistedName, hoistedTo] of dep.hoistedTo || EMPTY_MAP) {
        const originalId = hoistedTo.dependencies.get(hoistedName);
        let availableId: PackageId | undefined = undefined;
        for (let idx = 0; idx < newParentIndex; idx++) {
          availableId = graphPath[idx].dependencies?.get(hoistedName)?.id;
        }

        isHoistable = availableId === originalId ? Hoistable.YES : Hoistable.NO;

        if (isHoistable === Hoistable.NO) break;
      }
    }

    if (isHoistable !== Hoistable.NO) {
      break;
    }
  }

  // Check peer dependency promise
  if (isHoistable === Hoistable.YES) {
    if (dep.peerNames) {
      for (const peerName of dep.peerNames) {
        if (parentPkg.dependencies!.has(peerName)) {
          // The parent peer dependency was not hoisted, figuring out why...

          const depPriority = priorityIds.indexOf(dep.id);
          if (depPriority <= currentPriorityDepth) {
            // Should have been hoisted already, but is not the case
            isHoistable = Hoistable.NO;
            break;
          } else {
            // Should be hoisted later, wait
            isHoistable = Hoistable.LATER;
            priorityDepth = Math.max(priorityDepth, depPriority);
          }
        } else if (isHoistable === Hoistable.YES) {
          // The parent peer dependency was hoisted, finding the hoist point
          const hoistParent = parentPkg.hoistedTo!.get(peerName)!;
          const hoistIndex = graphPath.indexOf(hoistParent);
          newParentIndex = Math.max(newParentIndex, hoistIndex);
        }
      }
    }
  }

  if (isHoistable === Hoistable.LATER) {
    return { isHoistable, priorityDepth };
  } else if (isHoistable === Hoistable.YES) {
    return { isHoistable, newParentIndex };
  } else {
    return { isHoistable };
  }
};

/**
 * Gets regular node dependencies only and sorts them in the order so that
 * peer dependencies come before the dependency that rely on them.
 *
 * @param node graph node
 * @returns sorted regular dependencies
 */
const getSortedRegularDependencies = (node: Graph, originalDepNames: Set<PackageName>): Set<PackageName> => {
  const depNames: Set<PackageName> = new Set();

  const addDep = (depName: PackageName, seenDeps = new Set()) => {
    if (seenDeps.has(depName)) return;
    seenDeps.add(depName);
    const dep = node.dependencies!.get(depName)!;

    if (dep.peerNames) {
      for (const peerName of dep.peerNames) {
        if (originalDepNames.has(peerName) && !node.peerNames?.has(peerName)) {
          const peerDep = node.dependencies!.get(peerName);
          if (peerDep && !depNames.has(peerName)) {
            addDep(peerName, seenDeps);
          }
        }
      }
    }

    depNames.add(depName);
  };

  if (node.dependencies) {
    for (const depName of originalDepNames) {
      if (!node.peerNames?.has(depName)) {
        addDep(depName);
      }
    }
  }

  return depNames;
};

const hoistDependencies = (
  graphPath: Graph[],
  hoistPriorities: HoistPriorities,
  currentPriorityDepth: number,
  depNames: Set<PackageName>,
  options: Options,
  hoistQueue?: HoistQueue
) => {
  const parentPkg = graphPath[graphPath.length - 1];

  if (options.dump) {
    console.log(
      currentPriorityDepth === 0 ? 'visit' : 'revisit',
      graphPath.map((x) => x.id),
      depNames
    );
  }

  const sortedDepNames = depNames.size === 1 ? depNames : getSortedRegularDependencies(parentPkg, depNames);

  for (const depName of sortedDepNames) {
    const dep = parentPkg.dependencies!.get(depName)!;
    const verdict = getHoistVerdict(graphPath, depName, hoistPriorities, currentPriorityDepth);
    if (verdict.isHoistable === Hoistable.YES) {
      const rootPkg = graphPath[verdict.newParentIndex];
      const parentPkg = graphPath[graphPath.length - 1];
      if (parentPkg.dependencies) {
        parentPkg.dependencies.delete(depName);
        if (parentPkg.dependencies.size === 0) {
          delete parentPkg.dependencies;
        }
        if (!parentPkg.hoistedTo) {
          parentPkg.hoistedTo = new Map();
        }
        parentPkg.hoistedTo.set(depName, rootPkg);
      }
      if (!rootPkg.dependencies) {
        rootPkg.dependencies = new Map();
      }
      if (!rootPkg.dependencies.has(depName)) {
        rootPkg.dependencies.set(depName, dep);
      }

      if (options.dump) {
        console.log(
          graphPath.map((x) => x.id),
          'hoist',
          dep.id,
          'into',
          rootPkg.id,
          'result:\n',
          require('util').inspect(graphPath[0], false, null)
        );
      }
    } else if (verdict.isHoistable === Hoistable.LATER) {
      if (options.dump) {
        console.log('queue', graphPath.map((x) => x.id).concat([dep.id]));
      }

      hoistQueue![verdict.priorityDepth].push({ graphPath: graphPath.map((x) => x.id), depName });
    }
  }
};

type Options = {
  dump: boolean;
};

export const hoist = (pkg: Package, opts?: Options): Package => {
  const graph = toGraph(pkg);
  const options = opts || { dump: false };

  const priorities = getHoistPriorities(graph);
  let maxPriorityDepth = 0;
  for (const priorityIds of priorities.values()) {
    maxPriorityDepth = Math.max(maxPriorityDepth, priorityIds.length);
  }
  const hoistQueue: HoistQueue = [];
  for (let idx = 0; idx < maxPriorityDepth; idx++) {
    hoistQueue.push([]);
  }
  let priorityDepth = 0;

  const visitParent = (graphPath: Graph[], { isWorkspaceDep }: { isWorkspaceDep: boolean }) => {
    let node = graphPath[graphPath.length - 1];

    if (graphPath.length > 1) {
      const parentPkg = graphPath[graphPath.length - 2];
      const newPkg = decoupleNode(node);
      if (newPkg !== node) {
        node = newPkg;
        graphPath[graphPath.length - 1] = node;
        const pkgName = getPackageName(node.id);
        if (isWorkspaceDep) {
          parentPkg.workspaces!.set(pkgName, node);
        } else {
          parentPkg.dependencies!.set(pkgName, node);
        }
      }
    }

    if (graphPath.length > 1 && node.dependencies) {
      hoistDependencies(graphPath, priorities, priorityDepth, new Set(node.dependencies.keys()), options, hoistQueue);
    }

    if (graphPath.indexOf(node) === graphPath.length - 1) {
      if (node.workspaces) {
        for (const depWorkspace of node.workspaces.values()) {
          graphPath.push(depWorkspace);
          visitParent(graphPath, { isWorkspaceDep: true });
          graphPath.pop();
        }
      }

      if (node.dependencies) {
        for (const dep of node.dependencies.values()) {
          graphPath.push(dep);
          visitParent(graphPath, { isWorkspaceDep: false });
          graphPath.pop();
        }
      }
    }
  };

  visitParent([graph], { isWorkspaceDep: true });

  for (priorityDepth = 1; priorityDepth < maxPriorityDepth; priorityDepth++) {
    for (const queueElement of hoistQueue[priorityDepth]) {
      const graphPath: Graph[] = [graph];
      let parentPkg = graphPath[graphPath.length - 1];
      for (const id of queueElement.graphPath.slice(1)) {
        const name = getPackageName(id);
        const hoistedTo = parentPkg.hoistedTo?.get(name);
        if (hoistedTo && parentPkg.workspaces?.get(name)?.id !== id) {
          parentPkg = hoistedTo;
          let idx;
          let foundHoistParent = false;
          for (idx = 0; idx < graphPath.length - 1; idx++) {
            if (graphPath[idx].id === hoistedTo.id) {
              foundHoistParent = true;
              break;
            }
          }
          if (!foundHoistParent) {
            throw new Error(`Assertion: Unable to find hoist parent ${hoistedTo.id} for ${id}`);
          }
          graphPath.splice(idx + 1);
        }
        const parentDep = parentPkg.dependencies?.get(name);
        const parentWorkspaceDep = parentPkg.workspaces?.get(name);
        if (parentDep?.id === id) {
          graphPath.push(parentDep);
        } else if (parentWorkspaceDep?.id === id) {
          graphPath.push(parentWorkspaceDep);
        } else {
          throw new Error(
            `Assertion: Unable to find child node ${id} in ${parentPkg.id}` +
              (hoistedTo ? `which were previously hoisted from ${graphPath[graphPath.length - 1].id}` : ``)
          );
        }
        parentPkg = graphPath[graphPath.length - 1];
      }
      hoistDependencies(graphPath, priorities, priorityDepth, new Set([queueElement.depName]), options);
    }
  }

  if (options.dump) {
    console.log(require('util').inspect(graph, false, null));
  }

  return toPackage(graph);
};
