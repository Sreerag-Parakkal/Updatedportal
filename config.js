// Portal settings. Change the admin login here (or set the environment variables
// ADMIN_USERNAME / ADMIN_PASSWORD, which take priority). The admin login is fixed:
// it is not stored in the database and cannot be edited or deleted from the portal.
module.exports = {
  port: 3000,
  portalName: 'SCM SERVICE PORTAL',
  adminUsername: 'admin',
  adminPassword: 'Admin@12345', // CHANGE THIS before going live
  // Permanent storage in a private GitHub repository (see README, "Permanent online folder").
  // On a web host set these as environment variables instead (GITHUB_TOKEN, GITHUB_REPO).
  githubRepo: '',   // for example 'yourname/scm-portal-data' (must be a PRIVATE repository)
  githubToken: '',  // fine-grained token with Contents: Read and write on that one repository
};
