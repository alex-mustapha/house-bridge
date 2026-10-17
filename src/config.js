// Single source for the handful of names and defaults the whole system keys off.
//
// These four were spelled out inline 61 times across four files
// (`env.CHORES_PROJECT || "House Chores"` and friends), so each default lived in
// dozens of places and adding a project would have meant finding every one.
// Nothing here does I/O; it exists so the defaults cannot drift.

export const choresProject = (env) => env.CHORES_PROJECT || "House Chores";
export const adhocProject = (env) => env.ADHOC_PROJECT || "Ad Hoc";
export const recurringProject = (env) => env.RECURRING_PROJECT || "Recurring";
export const choresTeam = (env) => env.CHORES_TEAM || "CHO";

// The projects that hold do-able chores: recurring-generated plus one-offs.
// Searched by done / snooze / skip / cancel so ad-hoc work stays actionable.
// Deliberately excludes the Recurring project, which holds templates, not chores.
export const choreProjects = (env) => [choresProject(env), adhocProject(env)];
