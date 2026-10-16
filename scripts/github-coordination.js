#!/usr/bin/env node
/**
 * Epic Validation Script (/epic-validate / quality-gate)
 * 
 * Validates a single epic issue before publishing or review handoff.
 * 
 * Usage: node scripts/github-coordination.js validate <issue-number> --repo <owner/repo>
 *
 * Checks:
 * 1. Coordination state exists and is parseable
 * 2. Validation state is satisfied by policy
 * 3. Declared dependencies are closed
 * 4. The epic is ready for the next workflow stage
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Parse command line arguments
 * @param {Array<string>} args - Process arguments
 * @returns {Object} - Parsed arguments {issue, repo}
 */
function parseArgs(args) {
  const result = { issue: null, repo: null };
  let i = 0;

  while (i < args.length) {
    if (args[i] === 'validate') {
      // validate flag, next arg is issue number
      i++;
      if (i < args.length && !args[i].startsWith('--')) {
        result.issue = args[i];
      }
    } else if (args[i] === '--repo' && i + 1 < args.length) {
      result.repo = args[i + 1];
      i += 2;
    } else if (args[i].startsWith('--')) {
      i++; // skip unknown flag
    } else {
      // treat as issue number if not flagged
      if (!result.issue) {
        result.issue = args[i];
      }
      i++;
    }
  }

  return result;
}

/**
 * Load coordination state from the repo
 * @param {string} repo - Owner/repo string (e.g., "erpforgeafrica-dotcom/Promota")
 * @returns {Object|null} - Coordination state or null if not found
 */
function loadCoordinationState(repo) {
  // Try common paths for coordination state
  const possiblePaths = [
    `.agent/promota-epic-coordination.json`,
    `.agent/epic-coordination.json`,
    `docs/epic/coordination.json`,
    `audit/epic-coordination.json`,
    `.github/epic-coordination.json`,
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      try {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        data._sourcePath = p;
        return data;
      } catch (e) {
        console.error(`❌ Failed to parse ${p}: ${e.message}`);
      }
    }
  }

  // Try repo-specific path based on repo name
  let baseDir = '';
  if (repo.includes('Promota')) {
    baseDir = '.agent';
  } else if (repo.includes('OwoWorks')) {
    baseDir = '.agent';
  }

  if (baseDir) {
    const specificPath = path.join(baseDir, `promota-epic-coordination.json`);
    if (fs.existsSync(specificPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(specificPath, 'utf8'));
        data._sourcePath = specificPath;
        return data;
      } catch (e) {
        console.error(`❌ Failed to parse ${specificPath}: ${e.message}`);
      }
    }
  }

  return null;
}

/**
 * Policy validation rules for epic states
 * @type {Object}
 */
const POLICY_RULES = {
  // Validation states that are considered satisfied
  satisfiedStates: ['VALIDATED', 'APPROVED', 'READY_FOR_DEPLOY', 'READY_FOR_REVIEW'],

  // Validation states that are NOT satisfied
  blockedStates: ['DRAFT', 'PENDING', 'UNDER_REVIEW', 'UNVERIFIED'],

  // Required dependency types
  dependencyTypes: ['TEST_PASSED', 'CODE_REVIEW', 'SECURITY_SCAN', 'COMPATIBILITY_CHECK'],

  // Minimum confidence threshold
  minConfidence: 0.8,
};

/**
 * Check if validation state is satisfied by policy
 * @param {string} state - The current validation state
 * @returns {boolean} - Whether the state is policy-satisfied
 */
function isStateSatisfied(state) {
  if (!state) return false;
  const upperState = state.toUpperCase().trim();
  return POLICY_RULES.satisfiedStates.includes(upperState);
}

/**
 * Check if all declared dependencies are closed
 * @param {Object} coordinationState - The coordination state object
 * @returns {Object} - Dependency check results
 */
function checkDependencies(coordinationState) {
  const dependencies = coordinationState?.dependencies || [];
  const results = {
    total: dependencies.length,
    closed: 0,
    open: 0,
    missing: 0,
    details: [],
  };

  if (!Array.isArray(dependencies) || dependencies.length === 0) {
    results.noDependencies = true;
    return results;
  }

  for (const dep of dependencies) {
    const depUpper = (dep.status || dep.state || '').toUpperCase();
    const depName = dep.name || dep.id || 'unknown';

    if (depUpper === 'CLOSED' || depUpper === 'COMPLETED' || depUpper === 'PASSED') {
      results.closed++;
      results.details.push({ name: depName, status: 'closed' });
    } else if (depUpper === 'OPEN' || depUpper === 'PENDING' || depUpper === 'FAILED') {
      results.open++;
      results.details.push({ name: depName, status: 'open' });
    } else if (depUpper === 'NOT_APPLICABLE' || depUpper === 'SKIPPED') {
      // Count as closed by exception
      results.closed++;
      results.details.push({ name: depName, status: 'closed (by exception)' });
    } else {
      results.missing++;
      results.details.push({ name: depName, status: 'unknown' });
    }
  }

  return results;
}

/**
 * Validate coordination state structure
 * @param {Object} state - The coordination state to validate
 * @returns {Object} - Validation result
 */
function validateCoordinationState(state) {
  const errors = [];
  const warnings = [];

  // Check required fields
  if (!state.issueId) errors.push('Missing issueId');
  if (!state.validationState) errors.push('Missing validationState');
  if (!state.coordinationState) errors.push('Missing coordinationState');
  if (!state.dependencies) errors.push('Missing dependencies');

  // Check for optional but recommended fields
  if (state.confidence === undefined) warnings.push('Missing confidence score');
  if (!state.updatedAt) warnings.push('Missing updatedAt timestamp');
  if (!state.updatedBy) warnings.push('Missing updatedBy owner');

  // Validate coordinationState format
  if (state.coordinationState) {
    if (typeof state.coordinationState !== 'object') {
      errors.push('coordinationState must be an object');
    } else if (!state.coordinationState.name) {
      errors.push('coordinationState.name is required');
    }
  }

  // Validate dependencies array
  if (state.dependencies) {
    if (!Array.isArray(state.dependencies)) {
      errors.push('dependencies must be an array');
    } else if (state.dependencies.length === 0) {
      warnings.push('No dependencies declared - may need review');
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Main validation logic
 * @param {Object} args - Parsed arguments {issue, repo}
 * @returns {Object} - Full validation result
 */
async function validateEpic(args) {
  const { issue, repo } = args;

  if (!issue) {
    console.error('❌ Error: Issue number is required');
    console.error('Usage: node scripts/github-coordination.js validate <issue-number> --repo <owner/repo>');
    process.exit(1);
  }

  if (!repo) {
    console.error('❌ Error: Repository is required (--repo <owner/repo>)');
    console.error('Usage: node scripts/github-coordination.js validate <issue-number> --repo <owner/repo>');
    process.exit(1);
  }

  console.log(`🔍 Validating epic #${issue} for ${repo}`);
  console.log('========================================');

  // 1. Load coordination state
  const coordinationState = loadCoordinationState(repo);

  if (!coordinationState) {
    console.error(`❌ No coordination state found for ${repo}`);
    console.error('Looking in common paths...');
    console.error('Create a coordination state file first, or check the path.');
    process.exit(1);
  }

  console.log(`✅ Coordination state loaded from: ${coordinationState._sourcePath}`);

  // 2. Validate coordination state structure
  const structureValidation = validateCoordinationState(coordinationState);

  if (!structureValidation.isValid) {
    console.error('❌ Coordination state structure invalid:');
    structureValidation.errors.forEach(err => console.error(`   - ${err}`));
    process.exit(1);
  }

  // Report structure warnings
  structureValidation.warnings.forEach(warning => console.warn(`⚠️  ${warning}`));

  // 3. Check validation state satisfies policy
  const stateSatisfied = isStateSatisfied(coordinationState.validationState);

  console.log(`\n📊 Validation state: ${coordinationState.validationState}`);
  console.log(`   Policy satisfied: ${stateSatisfied}`);

  if (!stateSatisfied) {
    console.error('❌ Validation state does not satisfy policy requirements');
    console.error(`   Current state: ${coordinationState.validationState}`);
    console.error(`   Expected states: ${POLICY_RULES.satisfiedStates.join(', ')}`);
    process.exit(1);
  }

  // 4. Check dependencies are closed
  const depResults = checkDependencies(coordinationState);

  console.log(`\n🔗 Dependencies: ${depResults.closed}/${depResults.total} closed`);

  if (depResults.open > 0) {
    console.error(`❌ ${depResults.open} dependency(ies) still open`);
    depResults.details
      .filter(d => d.status === 'open')
      .forEach(d => console.error(`   - ${d.name}: ${d.status}`));
    process.exit(1);
  }

  if (depResults.missing > 0) {
    console.warn(`⚠️ ${depResults.missing} dependency(ies) have unknown status`);
    depResults.details
      .filter(d => d.status === 'unknown')
      .forEach(d => console.warn(`   - ${d.name}: ${d.status}`));
  }

  if (depResults.noDependencies) {
    console.log('   (No dependencies declared)');
  }

  // 5. Final readiness assessment
  const hasConfidence = coordinationState.confidence !== undefined;
  const confidenceLevel = hasConfidence ? coordinationState.confidence : 0;
  const confidencePass = confidenceLevel >= POLICY_RULES.minConfidence;

  console.log(`\n🎯 Readiness Assessment:`);
  console.log(`   Confidence: ${(confidenceLevel * 100).toFixed(1)}% (threshold: ${POLICY_RULES.minConfidence * 100}%)`);
  console.log(`   Confidence threshold: ${confidencePass ? 'PASS' : 'FAIL'}`);

  const allChecksPass =
    stateSatisfied &&
    depResults.open === 0 &&
    (depResults.missing === 0 || depResults.missing === depResults.total) &&
    confidencePass;

  console.log(`\n${allChecksPass ? '✅ EPIC VALIDATED AND READY FOR NEXT STAGE' : '❌ EPIC VALIDATION FAILED'}`);
  console.log('========================================');

  return {
    issue: parseInt(issue, 10) || issue,
    repo,
    coordinationState,
    structureValidation,
    stateSatisfied,
    depResults,
    confidence: confidenceLevel,
    allChecksPass,
    readyForNextStage: allChecksPass,
  };
}

/**
 * Entry point
 */
try {
  const args = process.argv.slice(2);
  const parsed = parseArgs(args);

  const result = validateEpic(parsed);

  // Output summary for machine readability
  console.log('\n---SUMMARY---');
  console.log(`issue: ${result.issue}`);
  console.log(`repo: ${result.repo}`);
  console.log(`readyForNextStage: ${result.readyForNextStage}`);
  console.log(`allChecksPass: ${result.allChecksPass}`);

  // Exit code matches readiness
  process.exit(result.readyForNextStage ? 0 : 1);
} catch (error) {
  console.error('❌ Fatal error during validation:');
  console.error(error.message);
  console.error(error.stack);
  process.exit(1);
}