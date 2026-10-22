/**
 * What "Add project" is about to do to the chosen path, phrased for the dialog.
 *
 * Adding a project may create the directory, run `git init`, and make an initial
 * commit of whatever is already sitting there — that last one touches the user's
 * files, so the dialog says so before they click rather than after.
 */

export interface ProjectTargetInput {
  /** null when nothing exists at the path */
  stat: { isDir: boolean } | null
  /** null while unknown, e.g. the status call failed */
  git: { isRepo: boolean; hasCommit: boolean; branch: string | null } | null
  /** entries directly inside the directory; undefined when it was not listed */
  entryCount?: number
}

export interface ProjectTarget {
  tone: 'info' | 'warn' | 'error'
  message: string
  /** true when Add project cannot go ahead */
  blocked: boolean
}

export function describeProjectTarget(input: ProjectTargetInput): ProjectTarget {
  const { stat, git, entryCount } = input

  if (stat === null) {
    return {
      tone: 'info',
      message: 'Does not exist yet — it will be created and initialized as a git repository.',
      blocked: false
    }
  }

  if (!stat.isDir) {
    return { tone: 'error', message: 'That path is a file, not a directory.', blocked: true }
  }

  if (git?.isRepo === true) {
    if (git.hasCommit) {
      const where = git.branch !== null ? ` on ${git.branch}` : ''
      return {
        tone: 'info',
        message: `Already a git repository${where} — its files are left untouched.`,
        blocked: false
      }
    }
    return {
      tone: 'warn',
      message:
        'A git repository with no commits — its current contents will be committed, ' +
        'so that sessions have something to branch from.',
      blocked: false
    }
  }

  if (entryCount === 0) {
    return {
      tone: 'info',
      message: 'Empty directory — it will be initialized as a git repository.',
      blocked: false
    }
  }

  return {
    tone: 'warn',
    message:
      'Not a git repository — `git init` will run here and everything currently ' +
      'inside will go into an initial commit.',
    blocked: false
  }
}
