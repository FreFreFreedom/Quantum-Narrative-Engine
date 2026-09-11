// scripts/signature-batch-civic.mjs — plans/anatomy-replaces-tags.md, Part 1, batch 2.
//
// The fifteen entities already touched by a written relation in data-seed/civic_relations.json,
// plus six characters whose own seed notes carry the same material first-hand. Every reading
// below is read off a note, a tag, or a relation already committed to the repo — nothing
// invented for the ladder. Where the material does not support a reading, it is left out
// rather than guessed; the honest count per entity is 1 to 4 of the four.
//
// Run against a real server, over HTTP, so it works the same way against a throwaway local
// boot or against production:
//   node scripts/signature-batch-civic.mjs http://localhost:8080 <admin-password>
//   node scripts/signature-batch-civic.mjs https://quantum-narrative-engine-production.up.railway.app <admin-password>

const [, , BASE, PASSWORD] = process.argv;
if (!BASE || !PASSWORD) {
  console.error('usage: node scripts/signature-batch-civic.mjs <base-url> <admin-password>');
  process.exit(1);
}

const READINGS = [
  // ── inst_organized_baseball_color_line ──────────────────────────────────
  { entity_id: 'inst_organized_baseball_color_line', reading: 'locus_of_exile',
    answer: 'Troy Maxson and every player like him — barred in their prime, and the 1947 repeal too late to give the years back.',
    points_at: 'c_troy_maxson', source_ref: 'data-seed/civic_cluster.json#inst_organized_baseball_color_line.note; c_troy_maxson.note',
    falsifier: 'A Black player on a major-league roster before 1947 would break this.' },
  { entity_id: 'inst_organized_baseball_color_line', reading: 'load_shift',
    answer: 'The bar is set and held nationally, but it is enforced locally, with no say in the matter — Pittsburgh inherits a rule it never wrote.',
    points_at: 'city_pittsburgh', source_ref: 'data-seed/civic_relations.json — inst_organized_baseball_color_line -> city_pittsburgh, vertical, 1889',
    falsifier: 'A Black player on a major-league roster reachable from Pittsburgh before 1947 would break this.' },

  // ── city_pittsburgh ──────────────────────────────────────────────────────
  { entity_id: 'city_pittsburgh', reading: 'locus_of_exile',
    answer: "The city's grammar of exclusion arrives in one department as an unwritten rule about who drives.",
    points_at: 'inst_pittsburgh_sanitation', source_ref: 'data-seed/civic_relations.json — city_pittsburgh -> inst_pittsburgh_sanitation, vertical, c.1930',
    falsifier: 'A Black driver on the Pittsburgh sanitation rolls before 1957 would break this.' },
  { entity_id: 'city_pittsburgh', reading: 'load_shift',
    answer: "The city's grammar of exclusion is decided at the level of policy and custom, but the felt cost is paid furthest down the chain it starts — in the two-man crew whose job depends on who is allowed to drive.",
    points_at: 'grp_truck_crew', source_ref: 'data-seed/civic_relations.json — the chain city_pittsburgh -> inst_pittsburgh_sanitation -> grp_truck_crew',
    falsifier: 'A crew organised without regard to the driving line would break this.' },
  { entity_id: 'city_pittsburgh', reading: 'sovereignty_reversal',
    answer: "A city whose promise of opportunity is administered as a grammar of exclusion, written into who gets the loan, the promotion, the truck.",
    points_at: null, source_ref: 'data-seed/civic_cluster.json#city_pittsburgh.note',
    falsifier: 'A resident of the Hill District in this period who received a loan or a promotion on the same terms as a white applicant would break this.' },

  // ── inst_pittsburgh_sanitation ───────────────────────────────────────────
  { entity_id: 'inst_pittsburgh_sanitation', reading: 'locus_of_exile',
    answer: 'Black drivers — the crew that lifts is not the crew that drives, a rule nobody had to write down until somebody asked why.',
    points_at: 'grp_truck_crew', source_ref: 'data-seed/civic_cluster.json#inst_pittsburgh_sanitation.note+posture',
    falsifier: 'A Black driver on the Pittsburgh sanitation rolls before 1957 would break this.' },
  { entity_id: 'inst_pittsburgh_sanitation', reading: 'load_shift',
    answer: "The department's rule about who drives lands on the two-man crew that lifts.",
    points_at: 'grp_truck_crew', source_ref: 'data-seed/civic_relations.json — inst_pittsburgh_sanitation -> grp_truck_crew, vertical, c.1950',
    falsifier: 'A crew organised across the driving line would break this.' },

  // ── grp_truck_crew ───────────────────────────────────────────────────────
  { entity_id: 'grp_truck_crew', reading: 'load_shift',
    answer: 'What the crew taught Troy about who is inside — kinship of loyalty, not blood — arrives at the dinner table as who is inside there, costing his own household the belonging it expected.',
    points_at: 'fam_maxson', source_ref: 'data-seed/civic_relations.json — grp_truck_crew -> fam_maxson, vertical, c.1950',
    falsifier: 'Troy holding a different boundary at home than at work would break this.' },
  { entity_id: 'grp_truck_crew', reading: 'loop_dynamics',
    answer: 'What the crew gives Troy — the only loyalty he actually trusts — returns when the household empties: with his son gone, the crew is the only structure left holding him. The boundary closes on itself.',
    points_at: 'fam_maxson', source_ref: 'data-seed/civic_relations.json — grp_truck_crew<->fam_maxson, vertical, c.1950 and 1965',
    falsifier: 'Troy rebuilding a household tie after Cory leaves would break the closure.' },

  // ── inst_nypd_manhattan_north ────────────────────────────────────────────
  { entity_id: 'inst_nypd_manhattan_north', reading: 'locus_of_exile',
    answer: 'The five adolescents interrogated are treated as though already outside the presumption owed to children — the panic finds its outlet in bodies the city can afford to suspect.',
    points_at: 'fam_mccray', source_ref: 'data-seed/civic_cluster.json#inst_nypd_manhattan_north.note+posture',
    falsifier: 'A contemporaneous departmental rule requiring a guardian, and evidence it was followed here, would break this.' },
  { entity_id: 'inst_nypd_manhattan_north', reading: 'load_shift',
    answer: "The city's panic over an unsolved case is not absorbed by the institution — it is pressed downward into the interrogation room, onto a father and his fourteen-year-old son.",
    points_at: 'fam_mccray', source_ref: 'data-seed/civic_relations.json — inst_nypd_manhattan_north -> fam_mccray, jump, 1989',
    falsifier: 'Evidence that a guardian was present and unpressured, or that the confession was not obtained in that room, would break this.' },
  { entity_id: 'inst_nypd_manhattan_north', reading: 'sovereignty_reversal',
    answer: 'An institution whose stated purpose is to protect the public becomes, in these rooms, the direct author of a false confession from a child.',
    points_at: null, source_ref: "data-seed/civic_cluster.json#inst_nypd_manhattan_north.note; tag protection-becomes-predation",
    falsifier: 'Evidence that due process protections were actually offered and followed in this room would break this.' },

  // ── fam_mccray ───────────────────────────────────────────────────────────
  { entity_id: 'fam_mccray', reading: 'locus_of_exile',
    answer: 'The son is the part of this family made to carry a confession that is not true — pushed, inside the interrogation room, beyond the family\'s ability to protect him.',
    points_at: 'c_antron_mccray', source_ref: 'data-seed/civic_cluster.json#fam_mccray.note',
    falsifier: 'Evidence the confession reflected an actual admission freely made would break this.' },
  { entity_id: 'fam_mccray', reading: 'load_shift',
    answer: 'The father, unable to bear the room any longer, tells his son to sign — moving the cost of the night from himself onto the boy, who carries the record from it for decades.',
    points_at: 'c_antron_mccray', source_ref: 'data-seed/civic_cluster.json#fam_mccray.note; c_bobby_mccray.note',
    falsifier: 'Evidence that a guardian was present and unpressured, or that the confession was not obtained in that room, would break this.' },

  // ── inst_baltimore_pd — all four ────────────────────────────────────────
  { entity_id: 'inst_baltimore_pd', reading: 'locus_of_exile',
    answer: 'CompStat makes the arrest tally the measure, so the corner is swept for whoever is standing on it — the population made the target of the count.',
    points_at: 'grp_the_corner_crew', source_ref: 'data-seed/civic_relations.json — inst_baltimore_pd -> grp_the_corner_crew, vertical, 1996',
    falsifier: 'A district in the same period evaluated on clearance quality rather than arrest count, with the same street effect, would break this.' },
  { entity_id: 'inst_baltimore_pd', reading: 'load_shift',
    answer: 'The demand for a number is decided above the department, at city hall; the department discharges that political cost downward as an arrest quota, onto the street.',
    points_at: 'grp_the_corner_crew', source_ref: 'data-seed/civic_relations.json — city_baltimore -> inst_baltimore_pd, 1994; inst_baltimore_pd -> grp_the_corner_crew, 1996',
    falsifier: 'The department adopting the tally against city hall\'s wishes would break this.' },
  { entity_id: 'inst_baltimore_pd', reading: 'sovereignty_reversal',
    answer: 'A patrol system built to protect the tissue of a neighbourhood inverts, under a tally it did not choose, into the main danger to that same tissue.',
    points_at: 'grp_the_corner_crew', source_ref: 'data-seed/civic_cluster.json#inst_baltimore_pd.note; data-seed/civic_relations.json 1996 relation, shape sh_protect_becomes_prey',
    falsifier: 'A district in the same period evaluated on clearance quality rather than arrest count, with the same street effect, would break this.' },
  { entity_id: 'inst_baltimore_pd', reading: 'loop_dynamics',
    answer: 'The corner is swept in 1996; the swept corner returns in 2004 as the violence the next quota is written to answer. The department\'s own output becomes its input.',
    points_at: 'grp_the_corner_crew', source_ref: 'data-seed/civic_relations.json — inst_baltimore_pd<->grp_the_corner_crew, 1996 and 2004',
    falsifier: 'Falling street violence following the sweeps, with quotas unchanged, would break this.' },

  // ── grp_the_corner_crew ──────────────────────────────────────────────────
  { entity_id: 'grp_the_corner_crew', reading: 'loop_dynamics',
    answer: 'What the department sweeps away resurfaces as violence, which becomes the next tally\'s justification — a circuit the corner did not start and cannot end on its own.',
    points_at: 'inst_baltimore_pd', source_ref: 'data-seed/civic_relations.json — inst_baltimore_pd<->grp_the_corner_crew, 1996 and 2004',
    falsifier: 'Falling street violence following the sweeps, with quotas unchanged, would break this.' },

  // ── city_baltimore ───────────────────────────────────────────────────────
  { entity_id: 'city_baltimore', reading: 'load_shift',
    answer: 'The city adopts the arrest tally as its measure of the department\'s performance, but never absorbs the political cost of that choice itself — the department carries it.',
    points_at: 'inst_baltimore_pd', source_ref: 'data-seed/civic_relations.json — city_baltimore -> inst_baltimore_pd, vertical, 1994',
    falsifier: 'The department adopting the tally against city hall\'s wishes would break this.' },
  { entity_id: 'city_baltimore', reading: 'sovereignty_reversal',
    answer: 'One pattern read at five rungs — the corner, the docks, city hall, the schools, the paper — each institution optimising for its own survival at the expense of the people it exists to serve.',
    points_at: null, source_ref: 'data-seed/civic_cluster.json#city_baltimore.note',
    falsifier: 'An institution in this period that measurably prioritised the public it served over its own survival metric would break this.' },

  // ── city_yonkers ─────────────────────────────────────────────────────────
  { entity_id: 'city_yonkers', reading: 'locus_of_exile',
    answer: 'The residents the desegregation order concerns most directly have no seat in the chamber where the city\'s answer is actually decided.',
    points_at: 'inst_yonkers_city_council', source_ref: 'data-seed/civic_cluster.json#city_yonkers.note; data-seed/civic_relations.json — city_yonkers -> inst_yonkers_city_council, 1987',
    falsifier: 'Evidence of direct representation for the affected residents in the council\'s deliberations would break this.' },
  { entity_id: 'city_yonkers', reading: 'load_shift',
    answer: 'A federal order the city will not own is pushed onto the council, which pushes it onto one office, which pushes it onto one man.',
    points_at: 'inst_yonkers_city_council', source_ref: 'data-seed/civic_relations.json — city_yonkers -> inst_yonkers_city_council, vertical, 1987',
    falsifier: 'The council absorbing the political cost itself would break this.' },

  // ── inst_yonkers_city_council ────────────────────────────────────────────
  { entity_id: 'inst_yonkers_city_council', reading: 'load_shift',
    answer: 'The council will not own the order itself, so it moves the whole weight onto one office — a single elected mayor left to carry what the whole body was asked to decide.',
    points_at: null, source_ref: 'data-seed/civic_cluster.json#inst_yonkers_city_council.note+posture',
    falsifier: 'Compliance before the contempt fines began would break the stated span.' },

  // ── inst_provisional_ira ─────────────────────────────────────────────────
  { entity_id: 'inst_provisional_ira', reading: 'locus_of_exile',
    answer: 'First a mother, taken and disappeared to hold the movement\'s own coherence (1972); then, once the movement becomes a party, the fighters it needed become an embarrassment and are exiled a second time, into silence (1998). Same mechanism, twice.',
    points_at: 'c_jean_mcconville', source_ref: 'data-seed/civic_relations.json — inst_provisional_ira -> fam_mcconville, 1972; inst_provisional_ira -> fam_price, 1998',
    falsifier: 'Contemporaneous acknowledgement by the organisation would break the silence half of this.' },
  { entity_id: 'inst_provisional_ira', reading: 'load_shift',
    answer: "The movement's need for coherence is not absorbed internally — it is discharged onto specific families, who bear the actual cost: disappearance, decades of not knowing.",
    points_at: 'fam_mcconville', source_ref: 'data-seed/civic_relations.json — inst_provisional_ira -> fam_mcconville, jump, 1972',
    falsifier: 'Contemporaneous acknowledgement by the organisation would break the silence half of this.' },
  { entity_id: 'inst_provisional_ira', reading: 'sovereignty_reversal',
    answer: 'A civic structure of resistance built against an outside power becomes, toward its own members and their families, the very machinery of exile and disappearance it was formed to fight.',
    points_at: null, source_ref: 'data-seed/civic_cluster.json#inst_provisional_ira.note; tag sovereignty-reversal',
    falsifier: 'Evidence the organisation held its own members and their families to the same protections it claimed to be fighting for would break this.' },

  // ── fam_mcconville ───────────────────────────────────────────────────────
  { entity_id: 'fam_mcconville', reading: 'locus_of_exile',
    answer: 'The mother is the part removed so the silence around her removal can hold; her ten children are left to be dispersed rather than exiled outright — the softer half of the same operation.',
    points_at: 'c_jean_mcconville', source_ref: 'data-seed/civic_cluster.json#fam_mcconville.note; c_jean_mcconville.note',
    falsifier: 'Contemporaneous acknowledgement by the organisation would break the silence half of this.' },
  { entity_id: 'fam_mcconville', reading: 'load_shift',
    answer: 'What the movement decided in a single act, this family pays for across decades and ten separate lives — dispersed into institutions once the household that held them is gone.',
    points_at: null, source_ref: 'data-seed/civic_cluster.json#fam_mcconville.note',
    falsifier: 'Evidence the children were kept together and supported, rather than dispersed, would break this.' },

  // ── fam_price ────────────────────────────────────────────────────────────
  { entity_id: 'fam_price', reading: 'locus_of_exile',
    answer: 'The daughters carry an obligation decided before they existed, and when the movement becomes a party, they are the part quietly exiled — an embarrassment now, not an asset.',
    points_at: 'c_dolours_price', source_ref: 'data-seed/civic_cluster.json#fam_price.note; data-seed/civic_relations.json — inst_provisional_ira -> fam_price, 1998',
    falsifier: 'Public acknowledgement of the operatives by the political wing in that period would break this.' },
  { entity_id: 'fam_price', reading: 'load_shift',
    answer: "The movement's turn to politics needs no visible armed history; the cost of that turn is paid by the people who carried out its history in good faith, now written out of the story.",
    points_at: 'inst_provisional_ira', source_ref: 'data-seed/civic_relations.json — inst_provisional_ira -> fam_price, jump, 1998',
    falsifier: 'Public acknowledgement of the operatives by the political wing in that period would break this.' },

  // ── c_troy_maxson ────────────────────────────────────────────────────────
  { entity_id: 'c_troy_maxson', reading: 'locus_of_exile',
    answer: 'Cory — the fence Troy builds to keep the world\'s violence out ends up being what exiles his own son from the house.',
    points_at: 'c_cory_maxson', source_ref: 'data-seed/civic_cluster.json#c_troy_maxson.note',
    falsifier: 'A scene of Troy inviting Cory back inside the boundary, on Cory\'s own terms, would break this.' },
  { entity_id: 'c_troy_maxson', reading: 'load_shift',
    answer: "Troy's own exclusion — the colour line, a penitentiary youth — is never processed or grieved; it is reissued as control over his household.",
    points_at: 'fam_maxson', source_ref: 'data-seed/civic_cluster.json#c_troy_maxson.note+tags (inherited-duty, duty-over-desire, violence-as-inheritance)',
    falsifier: 'A scene in which Troy processes his own exclusion without transmitting it as control over his son would break this.' },

  // ── c_antron_mccray ──────────────────────────────────────────────────────
  { entity_id: 'c_antron_mccray', reading: 'locus_of_exile',
    answer: 'Fourteen, kept awake thirty hours — he is pushed outside the presumption of innocence owed to a child, so the city\'s panic can find an outlet.',
    points_at: 'inst_nypd_manhattan_north', source_ref: 'data-seed/civic_cluster.json#c_antron_mccray.note; tag scapegoat-ritual',
    falsifier: 'Evidence he was afforded the same procedural protection as an adult suspect with counsel present throughout would break this.' },
  { entity_id: 'c_antron_mccray', reading: 'load_shift',
    answer: 'His own father\'s decision, made under the room\'s pressure, shifts the true cost from the father onto him — he carries the record for decades.',
    points_at: 'c_bobby_mccray', source_ref: 'data-seed/civic_cluster.json#c_antron_mccray.note; c_bobby_mccray.note',
    falsifier: 'Evidence the confession reflected an actual admission freely made, without his father\'s urging, would break this.' },

  // ── c_bobby_mccray ───────────────────────────────────────────────────────
  { entity_id: 'c_bobby_mccray', reading: 'load_shift',
    answer: "Under thirty hours of institutional pressure he tells his son to sign — moving the true cost of the night from himself onto the boy.",
    points_at: 'c_antron_mccray', source_ref: 'data-seed/civic_cluster.json#c_bobby_mccray.note; tag load-shifted-downward',
    falsifier: 'Evidence Bobby resisted the room\'s pressure and refused to counsel a signature would break this.' },
  { entity_id: 'c_bobby_mccray', reading: 'sovereignty_reversal',
    answer: 'His own paternal authority, meant to protect his son, collapses under the state\'s pressure into the very complicity that costs the boy his defence.',
    points_at: 'c_antron_mccray', source_ref: 'data-seed/civic_cluster.json#c_bobby_mccray.note',
    falsifier: 'A scene of Bobby successfully shielding Antron from signing would break this.' },

  // ── c_jean_mcconville ────────────────────────────────────────────────────
  { entity_id: 'c_jean_mcconville', reading: 'locus_of_exile',
    answer: "A widowed mother of ten, taken from her flat and disappeared, so the movement's own coherence can hold.",
    points_at: 'inst_provisional_ira', source_ref: 'data-seed/civic_cluster.json#c_jean_mcconville.note; tag the-disappeared',
    falsifier: 'Contemporaneous acknowledgement by the organisation would break the silence half of this.' },
  { entity_id: 'c_jean_mcconville', reading: 'load_shift',
    answer: 'Her removal shifts the cost of the movement\'s decision onto her ten children, dispersed once the household that held them is gone.',
    points_at: 'fam_mcconville', source_ref: 'data-seed/civic_cluster.json#c_jean_mcconville.note',
    falsifier: 'Evidence the children were kept together and supported would break this.' },

  // ── c_dolours_price ──────────────────────────────────────────────────────
  { entity_id: 'c_dolours_price', reading: 'locus_of_exile',
    answer: 'She carried out the movement\'s orders; once it becomes a party, the fighter it needed becomes an embarrassment, exiled a second time, into silence.',
    points_at: 'inst_provisional_ira', source_ref: 'data-seed/civic_cluster.json#c_dolours_price.note; tags loyalty-under-erasure, 22-years-of-silence',
    falsifier: 'Public acknowledgement of her role by the political wing in that period would break this.' },
  { entity_id: 'c_dolours_price', reading: 'load_shift',
    answer: 'The movement shifts the burden of memory onto her alone; she ends up recording her own confession for an archive because no living body would receive it.',
    points_at: 'inst_provisional_ira', source_ref: 'data-seed/civic_cluster.json#c_dolours_price.note',
    falsifier: 'A living institutional body formally receiving her confession while she was alive would break this.' },

  // ── c_brendan_hughes ─────────────────────────────────────────────────────
  { entity_id: 'c_brendan_hughes', reading: 'locus_of_exile',
    answer: 'The commander the movement needed and then could not acknowledge.',
    points_at: 'inst_provisional_ira', source_ref: 'data-seed/civic_cluster.json#c_brendan_hughes.note; tags loyalty-under-erasure, institutional-cannibalism',
    falsifier: 'Public acknowledgement of his command role by the movement during his lifetime would break this.' },
  { entity_id: 'c_brendan_hughes', reading: 'load_shift',
    answer: 'The movement shifts the cost of honesty onto a dead man\'s silence rather than bearing it while he lived — his testimony had to wait for his death to be released.',
    points_at: 'inst_provisional_ira', source_ref: 'data-seed/civic_cluster.json#c_brendan_hughes.note',
    falsifier: 'His testimony being received and acted on during his lifetime would break this.' },
];

async function main() {
  const tok = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  }).then((r) => r.json());
  if (!tok.token) { console.error('login failed:', JSON.stringify(tok)); process.exit(1); }
  const H = { Authorization: 'Bearer ' + tok.token, 'Content-Type': 'application/json' };

  let ok = 0, failed = 0;
  const byEntity = {};
  for (const r of READINGS) {
    const { entity_id, ...body } = r;
    const res = await fetch(`${BASE}/api/ontology/entities/${entity_id}/signature`, {
      method: 'POST', headers: H, body: JSON.stringify(body),
    });
    byEntity[entity_id] = (byEntity[entity_id] || 0) + (res.status < 400 ? 1 : 0);
    if (res.status >= 400) {
      failed++;
      console.error(`FAIL ${entity_id}/${r.reading}: ${res.status} ${await res.text()}`);
    } else {
      ok++;
    }
  }
  console.log(`\n${ok} readings written, ${failed} failed.`);
  console.log('per entity:', JSON.stringify(byEntity, null, 1));
}

main();
