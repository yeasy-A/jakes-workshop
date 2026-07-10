// scheduler.js — Tongues' pure Leitner RYG + session-building logic.
//
// Zero DOM, zero storage. Deterministic given (course, progressCards, nowIso, rng).
// Loaded by index.html as a classic <script src="scheduler.js"> (NOT type="module" —
// ES module fetches are blocked by CORS over file://, and this app must stay
// file://-openable). Also directly `require()`-able from Node for testing, since it
// checks for `module.exports` (UMD-style) at the bottom.
//
// Rules encoded here (from the Curriculum Forge / Tongues spec):
//   - Leitner RYG: red = due daily, yellow = due every 2-3 days, green = due weekly.
//   - Production gate (Oakley): a card leaves the "new" bucket ONLY after a correct
//     TYPED recall (typing the Spanish given the English). Recognition (multiple
//     choice) alone never graduates a card.
//   - "Today" session = all currently-due in_review cards + rate-limited NEW cards
//     (max 8 per session by default), drawn strictly in teaching_order — never a
//     random sample, never all 38 at once.
(function (root) {
  "use strict";

  var DAY_MS = 24 * 60 * 60 * 1000;
  var NEW_CARD_CAP = 8;
  var BOX_ORDER = ["red", "yellow", "green"];

  function intervalDaysForBox(box, rng) {
    var r = rng || Math.random;
    if (box === "red") return 1;
    if (box === "yellow") return r() < 0.5 ? 2 : 3;
    if (box === "green") return 7;
    return 1;
  }

  function addDays(iso, days) {
    var d = new Date(iso);
    d.setTime(d.getTime() + days * DAY_MS);
    return d.toISOString();
  }

  function newCardState() {
    return {
      status: "new",
      box: null,
      dueAt: null,
      typedRecallSuccess: false,
      introducedAt: null,
      seenCount: 0,
      lastSeen: null,
    };
  }

  function introduceNewCard(card, nowIso) {
    var c = Object.assign({}, card || newCardState());
    c.introducedAt = c.introducedAt || nowIso;
    c.seenCount = (c.seenCount || 0) + 1;
    c.lastSeen = nowIso;
    return c;
  }

  // The production gate. Only a CORRECT typed recall graduates the card out of "new".
  // An incorrect attempt still counts as exposure (seenCount++) but leaves status
  // 'new' — recognition alone (multiple choice) never reaches this function at all,
  // by construction: the app only calls applyTypedRecall from the typed-recall step.
  function applyTypedRecall(card, correct, nowIso, rng) {
    var c = introduceNewCard(card, nowIso);
    if (correct) {
      c.status = "in_review";
      c.box = "red";
      c.typedRecallSuccess = true;
      c.dueAt = addDays(nowIso, intervalDaysForBox("red", rng));
    }
    return c;
  }

  function promoteBox(box) {
    var i = BOX_ORDER.indexOf(box);
    if (i === -1) return "red";
    return BOX_ORDER[Math.min(i + 1, BOX_ORDER.length - 1)];
  }

  // Graded-test mode: multiple-choice / fill-blank outcome on an already-graduated card.
  function applyGradedReview(card, correct, nowIso, rng) {
    if (!card || card.status !== "in_review") {
      throw new Error("applyGradedReview requires an in_review (already-graduated) card");
    }
    var c = Object.assign({}, card);
    c.lastSeen = nowIso;
    c.seenCount = (c.seenCount || 0) + 1;
    c.box = correct ? promoteBox(c.box) : "red";
    c.dueAt = addDays(nowIso, intervalDaysForBox(c.box, rng));
    return c;
  }

  // Low-stress self-rate mode: the learner sets R/Y/G directly.
  function applySelfRate(card, chosenBox, nowIso, rng) {
    if (!card || card.status !== "in_review") {
      throw new Error("applySelfRate requires an in_review (already-graduated) card");
    }
    if (BOX_ORDER.indexOf(chosenBox) === -1) {
      throw new Error("invalid box: " + chosenBox);
    }
    var c = Object.assign({}, card);
    c.lastSeen = nowIso;
    c.seenCount = (c.seenCount || 0) + 1;
    c.box = chosenBox;
    c.dueAt = addDays(nowIso, intervalDaysForBox(chosenBox, rng));
    return c;
  }

  function isDue(card, nowIso) {
    return !!card && card.status === "in_review" && !!card.dueAt && card.dueAt <= nowIso;
  }

  // Build "Today": every due in_review card (red first, then yellow, then green;
  // ties broken by dueAt ascending) + up to `cap` NEW cards drawn in teaching_order,
  // skipping anything already graduated or already in_review.
  function buildTodaySession(course, progressCards, nowIso, opts) {
    opts = opts || {};
    var cap = opts.newCap != null ? opts.newCap : NEW_CARD_CAP;
    var boxRank = { red: 0, yellow: 1, green: 2 };

    var dueCardIds = [];
    for (var i = 0; i < course.leitner_card_ids.length; i++) {
      var id = course.leitner_card_ids[i];
      if (isDue(progressCards[id], nowIso)) dueCardIds.push(id);
    }
    dueCardIds.sort(function (a, b) {
      var ca = progressCards[a],
        cb = progressCards[b];
      var r = boxRank[ca.box] - boxRank[cb.box];
      if (r !== 0) return r;
      return (ca.dueAt || "").localeCompare(cb.dueAt || "");
    });

    var leitnerSet = {};
    for (var j = 0; j < course.leitner_card_ids.length; j++) leitnerSet[course.leitner_card_ids[j]] = true;

    var newCardIds = [];
    for (var k = 0; k < course.teaching_order.length; k++) {
      if (newCardIds.length >= cap) break;
      var tid = course.teaching_order[k];
      if (!leitnerSet[tid]) continue;
      var c = progressCards[tid];
      if (!c || c.status === "new") newCardIds.push(tid);
    }

    return { dueCardIds: dueCardIds, newCardIds: newCardIds };
  }

  // Loss-aversion cue: in_review yellow/green cards that are CURRENTLY due (i.e. sitting
  // overdue) are the ones at real risk of a missed review demoting them back to red.
  function cardsAboutToSlip(course, progressCards, nowIso) {
    var n = 0;
    for (var i = 0; i < course.leitner_card_ids.length; i++) {
      var c = progressCards[course.leitner_card_ids[i]];
      if (c && c.status === "in_review" && (c.box === "yellow" || c.box === "green") && c.dueAt && c.dueAt <= nowIso) {
        n++;
      }
    }
    return n;
  }

  // A lesson's pattern_card/dialogue block is "ready" once every sibling flashcard
  // block in that lesson has graduated out of 'new' (i.e. has produced at least one
  // successful typed recall) — so the grammar/capstone payoff always lands AFTER the
  // vocab that feeds it, never before.
  function isPatternReady(course, lesson, progressCards) {
    var siblingCardIds = lesson.block_ids.filter(function (id) {
      return course.blocks[id].flashcard;
    });
    if (siblingCardIds.length === 0) return false;
    return siblingCardIds.every(function (id) {
      var c = progressCards[id];
      return c && c.status === "in_review";
    });
  }

  var Scheduler = {
    DAY_MS: DAY_MS,
    NEW_CARD_CAP: NEW_CARD_CAP,
    BOX_ORDER: BOX_ORDER,
    intervalDaysForBox: intervalDaysForBox,
    addDays: addDays,
    newCardState: newCardState,
    introduceNewCard: introduceNewCard,
    applyTypedRecall: applyTypedRecall,
    promoteBox: promoteBox,
    applyGradedReview: applyGradedReview,
    applySelfRate: applySelfRate,
    isDue: isDue,
    buildTodaySession: buildTodaySession,
    cardsAboutToSlip: cardsAboutToSlip,
    isPatternReady: isPatternReady,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = Scheduler;
  }
  root.TonguesScheduler = Scheduler;
})(typeof window !== "undefined" ? window : globalThis);
