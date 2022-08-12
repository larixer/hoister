import { PackageName, PackageId, PackageType, WorkGraph } from './hoist';
import { getPackageName } from './parse';

export type HoistingPriorities = Map<PackageName, PackageId[]>;
export type Usages = Map<PackageId, Set<PackageId>>;
export type Children = Map<PackageId, number>;

export const getUsages = (graph: WorkGraph): Usages => {
  const packageUsages = new Map();

  const visitDependency = (graphPath: WorkGraph[]) => {
    const pkg = graphPath[graphPath.length - 1];
    let usedBy = packageUsages.get(pkg.id);
    const isSeen = !!usedBy;
    if (!usedBy) {
      usedBy = new Set();
      packageUsages.set(pkg.id, usedBy);
    }
    if (graphPath.length > 1) {
      usedBy.add(graphPath[graphPath.length - 2].id);
    }

    if (pkg.peerNames) {
      for (const peerName of pkg.peerNames.keys()) {
        let peerDep;
        for (let idx = graphPath.length - 2; idx >= 0; idx--) {
          peerDep = graphPath[idx].dependencies?.get(peerName);
          if (peerDep) {
            let usedBy = packageUsages.get(peerDep.id);
            if (!usedBy) {
              usedBy = new Set();
              packageUsages.set(peerDep.id, usedBy);
            }
            usedBy.add(pkg.id);
            break;
          }
        }
      }
    }

    if (!isSeen) {
      if (pkg.workspaces) {
        for (const dep of pkg.workspaces.values()) {
          graphPath.push(dep);
          visitDependency(graphPath);
          graphPath.pop();
        }
      }

      if (pkg.dependencies) {
        for (const dep of pkg.dependencies.values()) {
          graphPath.push(dep);
          visitDependency(graphPath);
          graphPath.pop();
        }
      }
    }
  };

  visitDependency([graph]);

  return packageUsages;
};

export const getChildren = (graph: WorkGraph): Children => {
  const children = new Map();

  const visitDependency = (graphPath: { node: WorkGraph; isWorkspace: boolean }[]) => {
    const pkg = graphPath[graphPath.length - 1].node;
    const pkgPriority = children.get(pkg.id);
    const isSeen = typeof pkgPriority !== 'undefined';
    if (graphPath.length > 1) {
      const parent = graphPath[graphPath.length - 2];
      let priority = 0;
      if (parent.isWorkspace) {
        priority = 1;
      } else if (parent.node.packageType === PackageType.PORTAL) {
        priority = 2;
      }
      children.set(pkg.id, Math.max(pkgPriority || 0, priority));
    }

    if (!isSeen) {
      if (pkg.workspaces) {
        for (const dep of pkg.workspaces.values()) {
          graphPath.push({ node: dep, isWorkspace: true });
          visitDependency(graphPath);
          graphPath.pop();
        }
      }

      if (pkg.dependencies) {
        for (const dep of pkg.dependencies.values()) {
          if (!dep.newParent || dep.newParent === pkg) {
            graphPath.push({ node: dep, isWorkspace: false });
            visitDependency(graphPath);
            graphPath.pop();
          }
        }
      }
    }
  };

  visitDependency([{ node: graph, isWorkspace: true }]);

  return children;
};

export const getPriorities = (usages: Usages, children: Children): HoistingPriorities => {
  const priorities = new Map();

  const pkgIds = Array.from(children.keys());
  pkgIds.sort((id1, id2) => {
    const priority1 = children.get(id1)!;
    const priority2 = children.get(id2)!;
    if (priority2 !== priority1) {
      return priority2 - priority1;
    } else {
      const usage1 = usages.get(id1)!.size;
      const usage2 = usages.get(id2)!.size;
      if (usage2 !== usage1) {
        return usage2 - usage1;
      } else {
        return id2 > id1 ? -1 : 1;
      }
    }
  });

  for (const pkgId of pkgIds) {
    const pkgName = getPackageName(pkgId);
    let priorityList = priorities.get(pkgName);
    if (!priorityList) {
      priorityList = [];
      priorities.set(pkgName, priorityList);
    }
    priorityList.push(pkgId);
  }

  return priorities;
};
