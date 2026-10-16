// The Prisma client lists the Prisma CLI and TypeScript as optional peers. pnpm satisfies optional peers from
// whatever the workspace has, so every production install of the client (the worker image, through @defe2end/db)
// pulled in the CLI and the TypeScript compiler. The client needs neither at run time; packages that run the CLI
// (packages/migrate, the db package's scripts) depend on it directly.
module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg.name === "@prisma/client") {
        for (const name of ["prisma", "typescript"]) {
          if (pkg.peerDependencies) delete pkg.peerDependencies[name];
          if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta[name];
        }
      }
      return pkg;
    },
  },
};
