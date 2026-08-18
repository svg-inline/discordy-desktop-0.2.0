const pkg = require('./package.json');

const repository = process.env.GITHUB_REPOSITORY || process.env.DISCORDY_GITHUB_REPOSITORY;
if (!repository || !repository.includes('/')) {
  throw new Error('Defina GITHUB_REPOSITORY ou DISCORDY_GITHUB_REPOSITORY como owner/repo.');
}

const [owner, repo] = repository.split('/');
if (!owner || !repo) throw new Error(`Repositório GitHub inválido: ${repository}`);

module.exports = {
  ...pkg.build,
  publish: [
    {
      provider: 'github',
      owner,
      repo,
      releaseType: 'release',
    },
  ],
};
