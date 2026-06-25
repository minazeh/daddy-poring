// ---------------------------------------------------------------------------
// Quiz question banks -- AUTO-GENERATED from
// inbox/discord-bot/function-2/questions-2.csv (full 7-class bank).
//
// druid: no bank in this CSV -- druid channel is wired in constants.js but
// getRandomQuestion('druid') returns null -> the loop warns and skips it
// gracefully. Add druid questions here when a bank is ready.
//
// Thief->assassin alias: any future CSV row with channel='thief' is folded
// into 'assassin' by the generator. Zero thief rows in the current source.
//
// The source CSV's "correct answer" column holds the correct option's TEXT (not a
// letter); the generator matched each to its A/B/C/D slot. Each question is:
//   { question: string, options: { A, B, C, D }, correctAnswer: 'A'|'B'|'C'|'D' }
//
// Counts: assassin=29, blacksmith=28, gunslinger=28, hunter=23, knight=42, priest=33, wizard=35

// NOTE: 2 row(s) skipped — correct_text did not match any option:
//   CSV row 109 [hunter]: '[WIND WALKER lv10] Increases MSPD for you and your teammates'
//     correct_text='30', opts=['35', '40', '45', '50']
//   CSV row 111 [hunter]: '[FALCON ASSAULT - ULTI SKILL] Charges natural energy with a '
//     correct_text='pull hit enemies toward the center of the whirlwind', opts=['', '', '', '']
// hunter count is 23 (not 25) due to these 2 broken CSV rows.
// ---------------------------------------------------------------------------

const QUESTIONS = {
  "assassin": [
    {
        "question": "[DOUBLE ATTACK lv10] When attacking or casting some skills with a Knife, has a 60% chance to increase hit count by 1, but __________. While wielding a Jur, P.DMG +5%.",
        "options": {
            "A": "cannot MOVE",
            "B": "cannot CRIT",
            "C": "cannot HIDE",
            "D": "cannot FLEE"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[ENVENOM lv10] Deals 280%+75 Poison Melee P.DMG to the target, with a __________.",
        "options": {
            "A": "25% chance to inflict Poison",
            "B": "50% chance to inflict Poison",
            "C": "75% chance to inflict Poison",
            "D": "100% chance to inflict Poison"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[DOUBLE SLASH lv10] Attacks the target twice. Each hit deals 200% + 55 Neutral Melee P.DMG to the target and up to 3 enemies within 1.5 m. This skill benefits from __________.",
        "options": {
            "A": "Double Attack",
            "B": "Hiding",
            "C": "Fatal Stab",
            "D": "Potent Venom"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[HIDING lv5] Enter stealth mode for 10s, immune to __________. Upon exiting, gain 15 Crit and 15% Crit DMG for 2.5s.",
        "options": {
            "A": "abnormal status effects",
            "B": "auto target",
            "C": "physical attacks",
            "D": "attacks and skill locks"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[IMPROVE DODGE lv10] FLEE +___.",
        "options": {
            "A": "5",
            "B": "10",
            "C": "15",
            "D": "20"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[DODGE lv5] Dashes 5 m in the target direction. This skill has __________.",
        "options": {
            "A": "1 charge",
            "B": "2 charges",
            "C": "3 charges",
            "D": "4 charges"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[STEAL] Has a 60% chance to steal 1 item from a monster. Success rate is affected by __________.\nCannot steal from targets already stolen from, Bosses, MVPs, Minis, or players.",
        "options": {
            "A": "level of the target",
            "B": "AGI difference with the target",
            "C": "LUK difference with the target",
            "D": "level difference with the target"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[VENOM KNIFE lv10] Throws a poisoned dagger at the target, dealing 700% + 310 Poison Ranged P.DMG and __________.",
        "options": {
            "A": "inflicting Poison",
            "B": "inflicting Stun",
            "C": "inflicting Bleed",
            "D": "inflicting Slow"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[TWO-HANDED MASTERY lv10] When equipped with two knives, P.ATK +10%, and weapon Size Modifier against Large targets becomes ___.",
        "options": {
            "A": "75%",
            "B": "100%",
            "C": "125%",
            "D": "150%"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[JUR MASTERY lv10] While wielding a Jur, P.ATK +___%.",
        "options": {
            "A": "5",
            "B": "8",
            "C": "10",
            "D": "15"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[VIRAL SPREAD lv10] Releases a Poisonous Smoke at the target location, poisoning up to __________ and reducing their Poison DMG Reduction by 34% for 8 sec.",
        "options": {
            "A": "5 targets within 3.5 m",
            "B": "5 targets within 4.5 m",
            "C": "10 targets within 3.5 m",
            "D": "10 targets within 4.5 m"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[ENCHANT POISON lv5] Changes own weapon element to Poison. Attacks have a _________ to Poison the target. Lasts 600 sec.",
        "options": {
            "A": "3% chance",
            "B": "5% chance",
            "C": "7% chance",
            "D": "10% chance"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[FATAL STAB lv10] Requires dual knives. Performs 4 stabs on the target. Each hit deals 210% + 160 Neutral Melee P.DMG to the target and up to 5 enemies in a 4 m rectangular area ahead. This skill benefits from __________.",
        "options": {
            "A": "Double Attack",
            "B": "Venom Knife",
            "C": "Venom Infection",
            "D": "Double Slash"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[SONIC BLOW lv10] Jur-only skill. Rapidly attacks the target, dealing 1152%+300 Neutral Melee P.DMG, with a 30% chance to Stun for 1 sec. P.Dmg Bonus increases by 20% when damaging targets below 50% HP. This skill _____.",
        "options": {
            "A": "cannot CRIT",
            "B": "cannot be DODGED",
            "C": "can CRIT",
            "D": "can trigger Double Attack"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[VENOM INFECTION lv10] Can only be cast on __________. Plants a toxic timed bomb in the target. After 3 sec, it explodes, dealing 1200% + 425 Poison Melee P.DMG to the target and up to 5 enemies within 3 m.",
        "options": {
            "A": "Poisoned or Deadly Poisoned targets",
            "B": "Non-Undead or Non-Shadow targets",
            "C": "Medium sized targets",
            "D": "Human targets"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[ENHANCED HIDING lv10] Increase 20% movement speed and 20 evasion while invisible, and increase 52% physical damage bonus. Immune to hard control abnormal status. This effect persists for _____ after invisibility is broken.",
        "options": {
            "A": "1 second",
            "B": "2 seconds",
            "C": "3 seconds",
            "D": "4 seconds"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[DEADLY AMPLIFICATION lv10] Fatal Stab P.Dmg Bonus and Hit Rate +___%.",
        "options": {
            "A": "5",
            "B": "10",
            "C": "15",
            "D": "18"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[SONIC ACCELERATION lv10] Sonic Blow damage and _____ +15%.",
        "options": {
            "A": "CRIT DMG",
            "B": "ASPD",
            "C": "HIT Rate",
            "D": "P.ATK"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[GRIMTOOTH lv10] Jur-only skill. Throws sharp fangs at the target, dealing 800%+320 Neutral Melee P.DMG to the target and up to 3 targets within 1.5 m. When cast during Hiding, P.Dmg Bonus increases by 30% and has a 57% chance __________ for 1.5 sec.",
        "options": {
            "A": "to Root the target",
            "B": "to Poison the target",
            "C": "to Stun the target",
            "D": "to Slow the target"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[ENCHANT DEADLY POISON lv10] P.ATK +11% and ASPD +15%. Basic Attack hits have a 10% chance to inflict __________ for 10 sec. Lasts 600 sec. Venom Knife damage multiplier +600%.",
        "options": {
            "A": "Venom Infection",
            "B": "Potent Venom",
            "C": "Deadly Poison",
            "D": "Venom Knife"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[ADVANCED JUR MASTERY lv10] While wielding a Jur, P.Dmg Bonus and _____ +5.5%.",
        "options": {
            "A": "Crit Rate",
            "B": "ASPD",
            "C": "HIT Rate",
            "D": "Crit Damage"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[ADVANCED TWO-HANDED MASTERY lv10] When dual-wielding _____, ASPD +18% and Basic Attack damage +12%.",
        "options": {
            "A": "katars",
            "B": "knives",
            "C": "swords",
            "D": "maces"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[POISON BUSTER lv10] Enters Poison Buster state. For the next 12 sec, Poison DMG +35%. When Poison Buster state ends, Deadly Poisoned enemies within 15 m explode, taking 2000% + 480 Poison Melee P.DMG and immediately __________.",
        "options": {
            "A": "inflicting Potent Venom",
            "B": "knocking back the target 3m",
            "C": "reducing target healing by 25%",
            "D": "settling remaining Deadly Poison damage"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[SOUL DESTROYER lv10] Performs a powerful ranged attack on the target, dealing (1300% + STR/100 + INT/100) * (ATK + MATK) Neutral Ranged P.DMG. This damage ignores Size Modifier. In PVE, this damage _____.",
        "options": {
            "A": "ignores 30% DEF",
            "B": "ignores 40% DEF",
            "C": "ignores 50% DEF",
            "D": "ignores 60% DEF"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[DANCING KNIFE lv10] When deadly skills hit a target, triggers Blood Blade Attack, dealing 800% Melee P.DMG to the target. Cooldown: 0.8 sec. This skill benefits from __________.",
        "options": {
            "A": "Basic Attacks",
            "B": "Double Attack",
            "C": "Deadly Poison",
            "D": "Double Slash"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[METEOR ASSAULT lv10] Deals 1300% + 700 Neutral Melee P.DMG to targets within 3 m, applies _____ for 10s, and has an 80% chance to inflict _____ for 1.5s.",
        "options": {
            "A": "Bleed / Blind",
            "B": "Stun / Blind",
            "C": "Poison / Blind",
            "D": "Poison / Bleed"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[ROLLING CUTTER lv10] Deals 900% + 670 Neutral Melee P.DMG to targets within 3 m. This skill _____.",
        "options": {
            "A": "cannot CRIT",
            "B": "can CRIT",
            "C": "cannot be DODGED",
            "D": "can be recast immediately"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[POTENT VENOM] Poison inflicted becomes Deadly Poison. Deadly Poisoned enemies take 200%+20 Poison P.DMG every sec and have _____.",
        "options": {
            "A": "P.DEF -35%",
            "B": "P.DEF -50%",
            "C": "M.DEF -35%",
            "D": "M.DEF -50%"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[SHADOW STAB - ULTI SKILL] Quickly hides in dark shadows, becoming __________. Performs multiple high-speed stabs in the shadows, dealing 5 hits of 270% Neutral Melee P.DMG. The slash marks left by the rapid stabs explode after a short delay, dealing 450% Neutral Melee P.DMG. After casting, gains P.DMG Bonus +20% for 5 sec.",
        "options": {
            "A": "untargetable by skills",
            "B": "untargetable by immune to status effects",
            "C": "untargetable by skills and immune to status effects",
            "D": "untargetable by damage over time effects"
        },
        "correctAnswer": "C"
    }
  ],
  "blacksmith": [
    {
        "question": "[CART REVOLUTION lv10] Smashes the target with a cart, dealing 400% * (1 + Cart Weight/5000) + 155 _____ to the target and up to 5 enemies within 1.5 m.",
        "options": {
            "A": "Neutral Melee P.DMG",
            "B": "Neutral Ranged P.DMG",
            "C": "Neutral M.DMG",
            "D": "Fire Melee P.DMG"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[MAMMONITE lv10] Uses the power of money to deal 660% + 190 _____ to the target.",
        "options": {
            "A": "Fire Melee P.DMG",
            "B": "Wind Melee P.DMG",
            "C": "Neutral Melee P.DMG",
            "D": "Neutral Melee M.DMG"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[SIDEKICK lv10] Summons a Sidekick for 300 sec. The Sidekick attacks nearby enemies every _____, dealing 235% Neutral Ranged P.DMG. Only 1 Sidekick can exist at a time.",
        "options": {
            "A": "0.5 sec",
            "B": "1 sec",
            "C": "1.5 sec",
            "D": "2 sec"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[CART MASTERY lv10] Cart-type skill P.Dmg Bonus +___%.",
        "options": {
            "A": "5",
            "B": "10",
            "C": "15",
            "D": "20"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[GREED lv10] Deals 800%+100 Neutral P.DMG to enemies and applies Greed Mark for 10 sec. Enemies affected by Greed Mark gain 15% P.Dmg Bonus from __________.",
        "options": {
            "A": "offensive skills",
            "B": "P.DMG skills",
            "C": "basic attacks",
            "D": "money skills"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[SHOUT lv5] Increases ___ for you and your teammates within 20 m by 12 and P.ATK by 27 for 600 sec.",
        "options": {
            "A": "VIT",
            "B": "CRIT",
            "C": "DEX",
            "D": "STR"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[PUSH CART] Allows use of ____________.",
        "options": {
            "A": "Cart Skills while moving",
            "B": "Cart Evolution",
            "C": "Cart Revolution",
            "D": "High Speed Cart Ram"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[BUY LOW, SELL HIGH] When buying items from shops, Adventure Coin price -___%. When selling items, Adventure Coin price +2%.",
        "options": {
            "A": "6",
            "B": "8",
            "C": "10",
            "D": "12"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[HAMMERFALL lv10] Deals 420% + 300 Neutral Melee P.DMG to up to __________, with a 90% chance to Stun them for 2 sec.",
        "options": {
            "A": "5 targets within 2 m",
            "B": "5 targets within 3 m",
            "C": "10 targets within 2 m",
            "D": "10 targets within 3 m"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[UNFAIR TRICK lv10] Money skill Adventure Coin cost -___%, and P.Dmg Bonus +15%",
        "options": {
            "A": "25",
            "B": "50",
            "C": "75",
            "D": "100"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[POWER SWING lv10] Swings a Battle Axe with force, dealing 800% + 320 Neutral Melee P.DMG to up to __________.",
        "options": {
            "A": "5 enemies within 2.5 m",
            "B": "5 enemies within 3.5 m",
            "C": "10 enemies within 2.5 m",
            "D": "10 enemies within 3.5 m"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[SHATTERING STRIKE lv5] Gains 11% Ignore P.DEF. When __________ hit players, has a 10% chance to inflict Weapon/Armor for 5s.",
        "options": {
            "A": "basic attacks",
            "B": "status effects",
            "C": "attacks or skills",
            "D": "P.DMG skills"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[FAW SILVER SNIPER lv10] Builds 1 FAW Silver Sniper for 60 sec. Silver Sniper automatically performs ranged attacks, dealing 150% Neutral Ranged P.DMG. _____ can exist at the same time.\nSilver Sniper dies after taking 40 hits.",
        "options": {
            "A": "Up to 1",
            "B": "Up to 2",
            "C": "Up to 3",
            "D": "Up to 4"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[HIGH SPEED CART RAM lv10] Rams the target with a cart full of money, dealing 400% * (1 + Cart Weight/5000)+325 Neutral Melee P.DMG to the target and up to __________.",
        "options": {
            "A": "10 targets within 2.5 m",
            "B": "10 targets within 4.5 m",
            "C": "5 targets within 2.5 m",
            "D": "5 targets within 4.5 m"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[AXE BOOMERANG lv10] Throws a spinning axe forward. The Axe Tornado deals 600% + 250 Neutral Melee P.DMG to enemies along its path __________.",
        "options": {
            "A": "when hitting for the first time",
            "B": "when returning",
            "C": "when flying out and returning",
            "D": "when hitting up to 3 targets"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[WEAPON PERFECTION lv10] Allows you and nearby teammates to __________ when attacking, and increases your DMG vs all sizes by 20% for 600 sec.",
        "options": {
            "A": "ignore weapon Size Modifier",
            "B": "ignore enemy P.DEF",
            "C": "ignore enemy Shield",
            "D": "ignore Elemental resistances"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[COMBAT ASSISTANCE lv10] Targets 1 enemy. Construction summons prioritize attacking that target, and the target gains 25% P.Dmg Bonus from __________ for 8 sec. When casting this skill, nearby Silver Snipers fire Armor Piercing Bullets at the target, dealing 300% Neutral Ranged P.DMG to the target and enemies within 1.5 m.",
        "options": {
            "A": "skill damage",
            "B": "summon damage",
            "C": "all damage",
            "D": "party damage"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[CART REVOLUTION DASH lv5] Pushes the cart and __________ the target, dealing 280% + 140 Neutral Melee P.DMG to enemies hit.",
        "options": {
            "A": "stuns",
            "B": "slows",
            "C": "pulls in",
            "D": "charges at"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[SPINNING AXE lv10] Throws 1 flying axe that circles around you. The axe spins for _____, dealing 350% + 150 Neutral Melee P.DMG to enemies it touches.",
        "options": {
            "A": "5 sec",
            "B": "8 sec",
            "C": "10 sec",
            "D": "12 sec"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[MAXIMISED WEAPON lv1] Maximizes own __________ for 600 sec.",
        "options": {
            "A": "weapon size advantage",
            "B": "weapon damage variance",
            "C": "elemental advantage",
            "D": "cooldown reduction"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[MECHANICAL HEART] Automatically casts all __________ skills after use.",
        "options": {
            "A": "maxed level buff",
            "B": "learned support buff",
            "C": "aoe skills",
            "D": "damage mitigation skills"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[HEAVY WEAPONRY RESEARCH lv10] While wielding __________, P.ATK and P.DEF +10%, and HIT Rate +40.",
        "options": {
            "A": "a sword or mace",
            "B": "a mace",
            "C": "an axe or mace",
            "D": "an axe"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[CART BOOST lv10] Gains __________, and High Speed Cart Ram multiplier +520% for 600 sec.",
        "options": {
            "A": "10% MSPD",
            "B": "15% MSPD",
            "C": "20% MSPD",
            "D": "25% MSPD"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[ADRENALINE RUSH lv10] Grants you and nearby teammates _____ +10% for 600 sec",
        "options": {
            "A": "CRIT",
            "B": "ASPD",
            "C": "P.ATK",
            "D": "P.DMG"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[FAW MAGIC DECOY lv10] Builds 1 FAW Magic Decoy for 120 sec. Magic Decoy increases __________ of all construction summons and their owner within 15 m by 10%. Every 20 sec, grants all summons in range 1 layer of protection, blocking 12 hits. Magic Decoy dies after taking 40 attacks.",
        "options": {
            "A": "P.ATK and P.DEF",
            "B": "P.ATK and P.DMG",
            "C": "P.ATK and Ignore P.DEF",
            "D": "P.DMG and Ignore P.DEF"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[AXE BLADE CYCLONE lv10] Rapidly swings an axe to create a powerful Axe Hurricane, dealing 1160% + 620 __________ to all enemies within 2.5 m.",
        "options": {
            "A": "Wind Melee P.DMG",
            "B": "Neutral Melee P.DMG",
            "C": "Wind M.DMG",
            "D": "Wind Ranged P.DMG"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[CONSTRUCTION MASTERY lv10] Construction skill cooldown -___%, and summon HP +22.",
        "options": {
            "A": "10",
            "B": "20",
            "C": "30",
            "D": "40"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[EARTH SHATTER - ULTI SKILL] Slams the ground, creating a rift that extends forward. Enemies touched take 1545% Neutral Melee P.DMG, are _____ for 0.5 sec, _____ for 5 sec, and have a 35% chance to receive _____ for 4 sec. The rift then erupts, dealing 375% Fire Melee P.DMG to enemies in range",
        "options": {
            "A": "Stunned / Slowed / Gear Break",
            "B": "Stunned / Silence / Gear Break",
            "C": "Stunned / Root / Gear Break",
            "D": "Stunned / Slowed / Silence"
        },
        "correctAnswer": "A"
    }
  ],
  "gunslinger": [
    {
        "question": "[CHAIN ACTION lv10] Each handgun attack has a 55% chance to perform a double attack, but __________.",
        "options": {
            "A": "consumes no bullets",
            "B": "only consumes 1 bullet",
            "C": "consumes 3 bullets",
            "D": "consumes double the bullets"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[BULL'S EYE lv10] Deals 500% Neutral Ranged P.DMG to the target. Has a ___ chance to make the target near death. Ineffective against players, Elites, and Bosses.",
        "options": {
            "A": "5%",
            "B": "2%",
            "C": "1%",
            "D": "0.10%"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[CROWD CONTROL SHOT lv10] Shotgun only. Deals 600% Neutral Ranged P.DMG to up to __________, with a 60% chance to inflict 30% Slow.",
        "options": {
            "A": "10 enemies in a cone",
            "B": "10 enemies in a rectangle",
            "C": "5 enemies in a circle",
            "D": "5 enemies in a cone"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[CRACKER lv10] Fires a shot to frighten the target, applying a Slow effect that reduces movement speed by 60% for 2 sec. When cast with a handgun, also has a 90% chance to apply Stun for ___. When cast with a shotgun, has a 100% chance to apply Stun for ___.",
        "options": {
            "A": "4 sec / 3 sec",
            "B": "3 sec / 4 sec",
            "C": "1 sec / 2 sec",
            "D": "1 sec / 1 sec"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[DESPERADO lv10] Handgun only. Fires wildly at surrounding enemies, dealing 2 hits of 350% AoE Neutral Ranged P.DMG to up to 10 enemies. Consumes __________ when used.",
        "options": {
            "A": "5 bullets",
            "B": "4 bullets",
            "C": "3 bullets",
            "D": "2 bullets"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[TRACKING lv10] Handgun and Rifle only. Carefully aims at an enemy before firing, dealing _____ Neutral Ranged P.DMG.",
        "options": {
            "A": "1000%",
            "B": "1100%",
            "C": "1200%",
            "D": "1300%"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[FULL BLAST lv10] Shotgun only. Fires __________, dealing 1300% Neutral Ranged P.DMG to the enemy.",
        "options": {
            "A": "half the remaining  bullets",
            "B": "3 bullets",
            "C": "4 bullets",
            "D": "all bullets at once"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[PLATINUM ALTAR lv10] Gains a shield equal to 18% Max HP for 120 sec. While the shield exists, _____.",
        "options": {
            "A": "ATK +40",
            "B": "ATK +50",
            "C": "ATK +70",
            "D": "ATK +100"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[ARMOR-PIERCING ROUNDS lv10] When using __________, has a 40% chance to ignore 40% of the target's P.DEF.",
        "options": {
            "A": "Basic Attacks",
            "B": "Skill Attacks",
            "C": "Basic and Skill Attacks",
            "D": "Ultimate Skill"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[DISARM lv10] Handgun and Rifle only. Shoots the enemy's hand with a 90% chance to __________. When used on monsters, reduces their ATK by 25% for 2 sec. Ineffective against Bosses.",
        "options": {
            "A": "inflict Stun",
            "B": "destroy target Armor",
            "C": "inflict Disarm",
            "D": "inflict Slow"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[CRUSHING STORM lv10] Shotgun only. Deals 1000% Neutral Ranged P.DMG to up to 10 enemies in the target area, with a 45% chance to inflict __________. Reduces monster DEF by 20% for 2 sec.",
        "options": {
            "A": "Armor Break",
            "B": "Stun",
            "C": "Blind",
            "D": "Slow"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[FALLEN ANGEL lv10] Handgun only. Teleports to a target location within 9 m. For 2 sec after teleporting, __________ deals an additional 600% damage.",
        "options": {
            "A": "Basic Attacks",
            "B": "Spread Shot",
            "C": "Desperado",
            "D": "Skill Attacks"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[GATLING FEVER lv10] Machine Gun only. Enters Fever state for 8 sec. __________ gradually increase with Basic Attack count, and Basic Attacks deal an additional 200% damage. ATK increases up to 120, and ASPD increases by 10%.",
        "options": {
            "A": "ATK and ASPD",
            "B": "CRIT and CRIT DMG",
            "C": "ATK and HIT",
            "D": "HIT and ASPD"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[ANTI MATERIAL BLAST lv10] Rifle only. Deals 2000% DMG to up to __________ along the shot path.",
        "options": {
            "A": "5 enemies in a rectangular area",
            "B": "5 enemies in a cone area",
            "C": "10 enemies in a rectangular area",
            "D": "10 enemies in a cone area"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[SPREAD SHOT lv10] Shotgun only. Fires bullets in a wide spread, dealing 1200% Neutral P.DMG to up to ___________ in front.",
        "options": {
            "A": "5 enemies within 5 m",
            "B": "5 enemies within 9 m",
            "C": "10 enemies within 5 m",
            "D": "10 enemies within 9 m"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[ETERNAL CHAIN lv10] Non-handgun firearms also have a chance to perform a __________. Trigger chance: 55%.",
        "options": {
            "A": "powerful attack",
            "B": "double attack",
            "C": "triple attack",
            "D": "stun attack"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[LAST STAND lv10] Enters final defense stance and __________. ATK +100, ASPD +18%. Use the skill again or wait 60 sec to remove the effect. Cannot coexist with Platinum Altar.",
        "options": {
            "A": "cannot cast skills",
            "B": "cannot be stunned",
            "C": "cannot move",
            "D": "cannot miss"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[FIREARM MASTERY] ASPD +15%. Desperado skill multiplier +___%. Tracking skill multiplier +1200%",
        "options": {
            "A": "150",
            "B": "200",
            "C": "250",
            "D": "300"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[MAGAZINE FOR ONE lv10] \nWhen cast with a _____: attacks 6 times, each dealing 200% Neutral Ranged P.DMG. at 10 Aim Count stacks, consumes Aim Count, and each hit deals 300% Neutral Ranged P.DMG.\nWhen cast with a _____: attacks 3 times, each dealing 400% Neutral Ranged P.DMG. at 10 Aim Count stacks, consumes Aim Count, and each hit deals 600% Neutral Ranged P.DMG.\nWhen cast with a _____: attacks 10 times, each dealing 150% Neutral Ranged P.DMG. at 10 Aim Count stacks, consumes Aim Count, and each hit deals 240% Neutral Ranged P.DMG.",
        "options": {
            "A": "Shotgun / Machine Gun / Handgun",
            "B": "Machine Gun / Handgun / Shotgun",
            "C": "Machine Gun / Shotgun / Handgun",
            "D": "Handgun / Shotgun / Machine Gun"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[UNIQUE BULLET lv10] Handgun and Rifle only. Fires 1 bullet, dealing 1800% damage. At ___ Aim Count stacks, consumes Aim Count and deals 3000% damage.",
        "options": {
            "A": "5",
            "B": "7",
            "C": "9",
            "D": "10"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[WILDFIRE lv10] Shotgun only. Fires bullets at the target location, dealing 3 rounds of 900% Neutral Ranged P.DMG to up to 10 enemies in the target area. at ___ Aim Count stacks, consumes Aim Count and deals 1200% Neutral Ranged P.DMG.",
        "options": {
            "A": "12",
            "B": "10",
            "C": "8",
            "D": "6"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[BLAZING CAVERN lv10] Throws a grenade, dealing 600% Neutral Ranged P.DMG to __________ in the target area.",
        "options": {
            "A": "up to 5 enemies",
            "B": "up to 8 enemies",
            "C": "up to 10 enemies",
            "D": "up to 15 enemies"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[FIRE DANCE lv10] Handgun only. Fires wildly at surrounding enemies, dealing 5 hits of 1200% AoE Neutral Ranged P.DMG to up to 10 enemies over 2 sec. Consumes _____ when used.",
        "options": {
            "A": "10 bullets",
            "B": "8 bullets",
            "C": "6 bullets",
            "D": "5 bullets"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[SPIRAL SHOT lv10] Rifle only. Fires a spinning bullet, dealing 1800% damage to up to 10 enemies total. at ___ Aim Count stacks, consumes Aim Count and deals 3000% damage.",
        "options": {
            "A": "10",
            "B": "8",
            "C": "6",
            "D": "5"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[AUTO GRENADE LAUNCHER lv10] Summons a drone that follows and automatically fires grenades. When you perform __________, has a 30% chance to fire a grenade. Damage is based on Hasty Fire in the Hole level. Lasts 8 sec.",
        "options": {
            "A": "Skill Attacks",
            "B": "Skill and Basic Attacks",
            "C": "Basic Attacks",
            "D": "Any Attack"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[GOD'S HAMMER lv10] Rifle only. Fires a flare to guide a laser cannon from above, striking up to _____ in the target area and dealing 2400% Neutral Ranged P.DMG.",
        "options": {
            "A": "15 enemies",
            "B": "12 enemies",
            "C": "10 enemies",
            "D": "5 enemies"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[FOCUSED AIM lv10] When using skills, enters Focused Aim. Gains 1 Aim Count every 0.5s, up to _____. Aim Count accumulation pauses while moving. During Focused Aim, gains ATK +150, HIT +250, and CRIT +30.",
        "options": {
            "A": "10 stacks",
            "B": "8 stacks",
            "C": "6 stacks",
            "D": "5 stacks"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[MISSION BOMBER] Summons a bomber to bombard the target location, dealing 12 hits of 187.5% + 5 damage to up to __________ over 3 sec. Each hit has a 5% chance to apply Blind for 5 sec and a 5% chance to apply 15% Slow for 5 sec.",
        "options": {
            "A": "5 enemies within 5 m",
            "B": "10 enemies within 5 m",
            "C": "5 enemies within 10 m",
            "D": "10 enemies within 10 m"
        },
        "correctAnswer": "B"
    }
  ],
  "hunter": [
    {
        "question": "[DOUBLE STRAFE lv10] Fires 2 arrows __________. Each arrow deals 170% + 60 Neutral Ranged P.DMG.",
        "options": {
            "A": "at the target",
            "B": "in an area",
            "C": "at up to 5 enemies",
            "D": "at up to 10 enemies"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[OWL'S EYE lv10] DEX +___.",
        "options": {
            "A": "10",
            "B": "15",
            "C": "20",
            "D": "30"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[ARROW SHOWER lv10] Fires a volley of arrows forward, dealing 300% + 65 Neutral Ranged P.DMG to up to 5 enemies in a __________.",
        "options": {
            "A": "9 m cone-shaped area",
            "B": "9 m rectangle-shaped area",
            "C": "5 m fan-shaped area",
            "D": "9 m fan-shaped area"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[VULTURE'S EYE lv10] HIT +20, Ranged P.DMG +___%.",
        "options": {
            "A": "5",
            "B": "10",
            "C": "15",
            "D": "18"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[ATTENTION CONCENTRATE lv10] After using Improve Concentration, __________ +10, and LUK +20 for 600 sec.",
        "options": {
            "A": "AGI and DEX",
            "B": "CRIT and CRIT DMG",
            "C": "ASPD and DEX",
            "D": "AGI and LUK"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[ARROW REPEL] Steps back 7 m and fires an arrow, dealing 100% Ranged P.DMG to the target and having an 80% chance to _____ them for 0.5 sec.",
        "options": {
            "A": "Knockback",
            "B": "Root",
            "C": "Stun",
            "D": "Fear"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[BLITZ BEAT lv10] Passive: When Basic Attacks hit, has a ___% chance to trigger Blitz Beat. Every 3 LUK increases the trigger chance by 1%, up to 45%\nActive: Commands the falcon to charge at the target, dealing [(80 + 6 * [Steel Crow Skill Lv.] + INT + DEX/2) + P.ATK] * 300% + 150 Neutral Ranged P.DMG to the target and up to 3 enemies within 1.5 m.",
        "options": {
            "A": "5",
            "B": "8",
            "C": "12",
            "D": "15"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[ARROW MASTERY lv10] When using a bow to perform __________, gains P.ATK +60. Using consumable arrows grants an additional P.ATK +30.",
        "options": {
            "A": "Basic Attacks",
            "B": "Cast Bow Skills",
            "C": "Abnormal Status effects",
            "D": "Basic Attacks or cast bow skills"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[CLAYMORE TRAP lv10] Places a Claymore Trap at the target location. When an enemy enters within ___ of the trap, it explodes, dealing (DEX + 75) * (1 + INT/50) * (2 + Skill Lv./5) * (1 + P.ATK/600) Fire Ranged P.DMG to up to 5 enemies within 3.5 m.",
        "options": {
            "A": "2 m",
            "B": "5 m",
            "C": "7 m",
            "D": "10 m"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[LAND MINE lv10] Places a Land Mine at the target location. When an enemy enters within 2 m of the trap, it explodes, dealing (DEX + 75) * (1 + INT/50) * (2 + Skill Lv./5) * (1 + P.ATK/1000) Earth Ranged P.DMG to up to __________, with a 70% chance to inflict Stun for 2 sec.",
        "options": {
            "A": "10 enemies within 3.5 m",
            "B": "10 enemies within 2.5 m",
            "C": "5 enemies within 2.5 m",
            "D": "5 enemies within 3.5 m"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[STEEL CROW lv10] Falcon P.ATK +60 when __________ deal damage.",
        "options": {
            "A": "basic attacks",
            "B": "skill attacks",
            "C": "attacks and skills",
            "D": "elemental attacks"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[BEASTBANE lv10] Race DMG Bonus vs __________ +10%.",
        "options": {
            "A": "Brute and Fish",
            "B": "Insect and Fish",
            "C": "Dragon and Brute",
            "D": "Brute and Insect"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[CRESCIVE BOLT lv10] Passive: Bow skill cast range +___ m;\nActive: Bow-only skill. Fires 4 consecutive shots at the target. Each shot deals 270%+270 Neutral Ranged P.DMG. The final shot's skill multiplier increases by 50%.",
        "options": {
            "A": "2",
            "B": "3",
            "C": "4",
            "D": "5"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[BLAST MINE lv10] Places a Blast Mine at the target location. When an enemy enters within 2 m of the trap, it activates. After a _____ delay, deals (DEX/2 + 50) * (1 + INT/50) * (2 + Skill Lv./5) * (1 + P.ATK/800) Wind Ranged P.DMG to up to 5 enemies within 3.5 m.",
        "options": {
            "A": "0.5 sec",
            "B": "1 sec",
            "C": "2 sec",
            "D": "3 sec"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[FREEZING TRAP lv10] Places a Freezing Trap at the target location. After a short delay, releases Frost Impact at the location, dealing (DEX+75)*(1+INT/50)*(2+Skill Lv./5)*(1+P.ATK/700) Water Ranged P.DMG to up to 5 enemies within 3.5 m and __________, reducing MSPD by 30% for 4.5 sec.",
        "options": {
            "A": "applies Freeze",
            "B": "applies Petrify",
            "C": "applies Slow",
            "D": "applies Stun"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[DETECTING lv3] The falcon reveals hidden targets within ___ of its location for 3 sec.",
        "options": {
            "A": "5 m",
            "B": "6 m",
            "C": "7 m",
            "D": "8 m"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[FALCONRY MASTERY] Gains a falcon for __________.",
        "options": {
            "A": "looting items",
            "B": "revealing invisible units",
            "C": "dispelling debuffs",
            "D": "coordinated combat"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[FALCON ASSAULT lv10] Passive: Blitz Beat skill multiplier +90%. After Lv. 5, _____ +25%\nActive: Enters Hunting Mode. for the next 10 sec, Blitz Beat applies Hunting Mark to enemies hit for 6 sec. Hunting Mark increases damage taken from falcon skills by 20%.",
        "options": {
            "A": "CRIT",
            "B": "P.ATK",
            "C": "P.DMG",
            "D": "ASPD"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[FOCUSED ARROW STRIKE lv10] Bow-only skill. Fires a powerful Arrow, dealing 1300%+1200Neutral Ranged P.DMG to up to 5 enemies in an 11 m line. This damage can CRIT and inherits ___% of CRIT ratio.\nAfter Focused Arrow Strike exceeds Lv.10, increases the burst skill damage of the Special Skill \"Burst Shot\". Current increase: 0%.",
        "options": {
            "A": "15",
            "B": "25",
            "C": "35",
            "D": "50"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[ENHANCED ELEMENTAL TRAP lv10] Increases the range of the next Claymore Trap, Blast Mine, Land Mine, or Freezing Trap and grants an enhanced effect;\nClaymore Trap: Explosion range increases to 5 m and deals 80% additional damage;\nBlast Mine: Trigger delay is reduced to 0.2 sec. After exploding, leaves a whirlwind for 4 sec, dealing 100%+110 Wind Ranged P.DMG every sec to enemies within 4 m;\nLand Mine: Explosion range increases to 5 m and applies _____ to enemies for 4.5 sec;\nFreezing Trap: on HIT, has a 60% chance to Freeze for 1.5 sec.",
        "options": {
            "A": "Burning",
            "B": "Vulnerable",
            "C": "Bleed",
            "D": "Root"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[FALCON EYES lv10] All stats +5, HIT and CRIT +30, and __________ +10% for 600s.",
        "options": {
            "A": "P.DMG",
            "B": "P.ATK",
            "C": "physical skill damage",
            "D": "basic attack damage"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[FLASHER lv5] When an enemy enters within 2 m of the trap, releases a bright flash, with a 60% chance to inflict Blind for ___ sec.",
        "options": {
            "A": "1.5",
            "B": "2.5",
            "C": "3.5",
            "D": "4.5"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[ANKLESNARE lv5] When an enemy enters within 2 m of the trap, activates a powerful snare, with an ___% chance to Root the target for 2.5 sec.",
        "options": {
            "A": "50",
            "B": "60",
            "C": "70",
            "D": "80"
        },
        "correctAnswer": "D"
    }
  ],
  "knight": [
    {
        "question": "[BASH] Strikes the target with force, __________.",
        "options": {
            "A": "dealing Neutral Melee P.DMG",
            "B": "dealing Neutral Ranged P.DMG",
            "C": "dealing P.DMG and stunning target",
            "D": "dealing Holy Melee P.DMG"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[MAGNUM BREAK] Deals Fire Melee P.DMG to up to __________. Also changes attack element to Fire and increases Fire Skill DMG by for 10 sec.",
        "options": {
            "A": "10 enemies within 3m and knocks them back 2m",
            "B": "10 enemies within 5m and knocks them back 2m",
            "C": "5 enemies within 5m and knocks them back 3m",
            "D": "5 enemies within 3m and knocks them back 2m"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[FATAL BLOW] After Bash hits enemies 3 times, the next Bash deals additional damage and has a __________. This effect has a 12 sec cooldown.",
        "options": {
            "A": "50% chance to Stun the target for 2 sec",
            "B": "65% chance to Stun the target for 1 sec",
            "C": "50% chance to Stun the target for 1 sec",
            "D": "30% chance to Stun the target for 2 sec"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[BERSERK] When __________, STR increases for 8 sec. Stacks up to 4 times.",
        "options": {
            "A": "hitting an enemy or being attacked",
            "B": "being attacked",
            "C": "hitting an enemy",
            "D": "inflicting abnormal status on the target"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[PROVOKE] Provoke up to __________, forcing monsters to attack you for 6 sec. Taunted enemy players gain Slow, MSPD reduction. Pdmg reduction increases when hit by taunted enemies.",
        "options": {
            "A": "10 enemies within 5m",
            "B": "10 enemies within 7m",
            "C": "6 enemies within 5m",
            "D": "5 enemies within 10m"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[INCREASE HP RECOVERY] Restores an additional HP every __________.",
        "options": {
            "A": "5 sec",
            "B": "10 sec",
            "C": "7 sec",
            "D": "3 sec"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[BATTLE VETERAN] When using a sword, __________ increases. While wielding a shield, __________ increases.",
        "options": {
            "A": "ATK / P.DEF",
            "B": "HIT / P.DEF",
            "C": "ATK / M.DEF",
            "D": "HIT / P.DMG Reduction"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[SWORD ASPD BOOST] Sword-only skill. For some sec, _____, _____, and ______ increases. The effect is removed when equipping a non-sword weapon.",
        "options": {
            "A": "APSD, CRIT DMG, and HIT",
            "B": "APSD, CRIT, and HIT",
            "C": "APSD, MSPD, and HIT",
            "D": "APSD, PDMG, and HIT"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[CAVALRY TRAINING] Restores _____ while mounted.",
        "options": {
            "A": "HP",
            "B": "P.DMG",
            "C": "HIT",
            "D": "ASPD"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[SPEAR STAB] Spear-only skill. Thrusts with a spear, dealing Neutral Melee P.DMG to up to __________.",
        "options": {
            "A": "5 enemies in a 4m rectangular area ahead.",
            "B": "10 enemies in a 3m cone area ahead.",
            "C": "5 enemies in a 3m rectangular area ahead.",
            "D": "10 enemies in a 4m triangular area ahead."
        },
        "correctAnswer": "A"
    },
    {
        "question": "[SPEAR MASTERY] While wielding a spear, P.ATK increases. While mounted, additionally __________.",
        "options": {
            "A": "reduces 50% bonus",
            "B": "gains 50% bonus",
            "C": "gains 25% bonus",
            "D": "reduces 25% bonus"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[HEROIC STRIKE] Deals Neutral Melee P.DMG to up to 5 enemies in a 3m frontal semicircle, and restores HP equal to a mix of ATK and Max HP. Base Healing cannot exceed ___ Max HP, reduced to ___ in PVP.",
        "options": {
            "A": "10% /  4.5%",
            "B": "8% /  3.5%",
            "C": "6% /  3%",
            "D": "4% /  2.5%"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[BOWLING BASH] Passive: When using a Slayer, Bowling Bash hit count +1. Active: Sword-only skill. Slashes up to 5 enemies within the target __________. Each slash deals Neutral Melee P.DMG.",
        "options": {
            "A": "3.5m area 5 times",
            "B": "3m area 4 times",
            "C": "2m area 3 times",
            "D": "1.5m area 2 times"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[SWORD MASTERY] While wielding a sword, P.ATK increases. While wielding a Slayer, additionally gains __________.",
        "options": {
            "A": "20% bonus",
            "B": "30% bonus",
            "C": "40% bonus",
            "D": "50% bonus"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[PIERCE] Spear-only skill. Continuously thrusts at the target, dealing 2 hits of Neutral Melee P.DMG. Deals __________.",
        "options": {
            "A": "1 and 1 additional hits to Medium and Large targets respectively",
            "B": "1 and 2 additional hits to Medium and Large targets respectively",
            "C": "2 and 3 additional hits to Medium and Large targets respectively",
            "D": "2 and 2 additional hits to Medium and Large targets respectively"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[BURNING BLOOD] Consumes % Max HP to gain a fire shield equal to % Max HP for 8 sec. Every 0.5 sec for the next 8 sec, deals Fire Melee P.DMG to up to __________.",
        "options": {
            "A": "3 enemies within 2.5 m and applies Slow, reducing their MSPD by 10%",
            "B": "4 enemies within 2.5 m and applies Slow, reducing their MSPD by 20%",
            "C": "5 enemies within 2.5 m and applies Slow, reducing their MSPD by 10%",
            "D": "10 enemies within 2.5 m and applies Slow, reducing their MSPD by 15%"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[CHARGE ATTACK] Charges at an enemy, dealing % Neutral Melee P.DMG and having a % chance to Root for 2 sec. While wielding a Spear, __________.",
        "options": {
            "A": "charge distance +3 m and applies Stun instead of Root",
            "B": "charge distance +3 m and applies Slow instead of Root",
            "C": "charge distance +5 m and applies Stun instead of Root",
            "D": "charge distance +5 m and applies Slow instead of Root"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[BRANDISH SPEAR] Spear-only skill. __________. Swings the spear with force, dealing % Neutral Melee P.DMG to up to 5 enemies within a 3 m target area.",
        "options": {
            "A": "Can only be used while mounted",
            "B": "Can only be used while in combat",
            "C": "Can only be used while outside abnormal status",
            "D": "Can only be used while above 50% HP"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[AUTO COUNTER] When taking damage, __________, dealing % Neutral Melee P.DMG to up to 5 enemies within 2 m, and reducing their damage output to you by % for 6 sec. Counter trigger has a 2 sec cooldown.\nWhen Counter reaches Lv.5, skill damage taken from monsters -30%.",
        "options": {
            "A": "has a 10% chance to immediately counterattack nearby enemies",
            "B": "has a 20% chance to immediately counterattack nearby enemies",
            "C": "has a 30% chance to immediately counterattack nearby enemies",
            "D": "has a 40% chance to immediately counterattack nearby enemies"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[AURA BLADE] Infuses the weapon with aura. For 60 sec, all physical attacks deal an additional Neutral Melee P.DMG. This additional damage __________.\nAfter Aura Blade exceeds Lv. 10, each level increases Basic Attack damage and the sword energy Skill DMG of the Special Skill \"Sword Energy Surge\".",
        "options": {
            "A": "splashes in a 3.5m radius",
            "B": "cannot be blocked or evaded",
            "C": "ignores the target's P.DEF",
            "D": "applies Vulnerability"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[JOINT BEAT] Passive: When spear skills deal damage, has a % chance to cast Joint Beat on the enemy.\nActive: Spear-only skill. Strikes the enemy's joints with precision, dealing % Neutral Melee P.DMG and inflicting a random joint fracture status for _____.",
        "options": {
            "A": "5 sec",
            "B": "10 sec",
            "C": "15 sec",
            "D": "20 sec"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[CONCENTRATION] Increases offensive focus, granting ___ +10 and physical Skill DMG +% for 600 sec.",
        "options": {
            "A": "CRIT",
            "B": "FLEE",
            "C": "P.ATK",
            "D": "HIT"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[PARRYING] Passive: While wielding a sword, has a % chance to block P.DMG from __________.\nActive: Sword-only skill. for 4 sec, P.DMG taken -% and M.DMG taken -%.",
        "options": {
            "A": "Basic Attacks",
            "B": "All attacks",
            "C": "Ranged attacks",
            "D": "P.DMG attacks"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[CLASHING SPIRAL] Extends the spear in a spiral to pierce the enemy, attacking 5 times. Each hit deals % Neutral Melee P.DMG. This damage increases based on __________.",
        "options": {
            "A": "STR and has special Size Modifier",
            "B": "P.ATK and has special Size Modifier",
            "C": "weapon weight and has special Size Modifier",
            "D": "max HP and has special Size Modifier"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[TRAUMATIC BLOW] Strikes the enemy with heavy pressure, dealing % P.DMG and __________. Bleeding enemies take % Neutral P.DMG every sec, Received Healing -%, and cannot naturally recover HP.",
        "options": {
            "A": "applying Bleed for 5 sec",
            "B": "applying Bleed for 8 sec",
            "C": "applying Bleed for 10 sec",
            "D": "applying Bleed for 12 sec"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[BERSERK] Can only be cast when HP is above 5%. Enters Frenzy for X sec. Removes all control effects and fully restores HP. Max HP +%, P.ATK +%, and MSPD +%, but loses 3% Max HP every sec, P.DEF and M.DEF -80%, cannot receive Healing or recovery effects, and cannot use skills for 10 sec. When HP drops below ___, this effect is automatically removed.",
        "options": {
            "A": "5%",
            "B": "10%",
            "C": "15%",
            "D": "20%"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[PECO PECO RIDE] Can ride a trained Peco Peco. While mounted, MSPD +25% and max weight +1000, but _____.",
        "options": {
            "A": "ASPD -20%",
            "B": "ASPD -30%",
            "C": "ASPD -40%",
            "D": "ASPD -50%"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[UNYIELDING] When casting Endure, removes all __________ effects from you. During Endure, Control Res against these statuses +50%.",
        "options": {
            "A": "Stun, Silence, Blind, and Root",
            "B": "Stun, Freeze, Blind, and Root",
            "C": "Stun, Freeze, Petrify, and Root",
            "D": "Stun, Silence, Petrify, and Root"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[MIGHTY STRIKE] Brave Strike's skill multiplier increases by ___%, Burning Blood's skill multiplier increases by ___%.",
        "options": {
            "A": "100% / 200%",
            "B": "200% / 200%",
            "C": "50% / 100%",
            "D": "50% / 50%"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[BATTLE VETERAN] When using a sword, HIT +___. While wielding a shield, P.DMG Reduction +___.",
        "options": {
            "A": "20 / 5%",
            "B": "30 / 5%",
            "C": "20 / 10%",
            "D": "25 / 15%"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[SMITE] Shield-only skill. Smashes the target with a shield, dealing % Neutral Melee P.DMG to the target and up to 3 enemies within 1.5 m, with a 15% chance to Stun for ___.",
        "options": {
            "A": "1.0 sec",
            "B": "1.5 sec",
            "C": "3.0 sec",
            "D": "4.5 sec"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[HOLY CROSS] Attacks the target with a holy cross, dealing % Holy Melee P.DMG, with a 20% chance to inflict Blind for ___.",
        "options": {
            "A": "1 sec",
            "B": "2 sec",
            "C": "3 sec",
            "D": "4 sec"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[SHIELD BOOMERANG] Shield-only skill. Throws the shield at the target. The shield bounces between up to _____, dealing % Neutral Melee P.DMG.",
        "options": {
            "A": "3 targets",
            "B": "4 targets",
            "C": "5 targets",
            "D": "8 targets"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[GRAND CROSS] Calls down divine judgment in a cross shape centered on you, dealing % Holy Melee P.DMG to up to __________.",
        "options": {
            "A": "5 enemies within 2.5 m",
            "B": "5 enemies within 4.5 m",
            "C": "10 enemies within 4.5 m",
            "D": "10 enemies within 10 m"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[FAITH] Max HP increases, _____ Reduction +%.",
        "options": {
            "A": "P.DMG",
            "B": "Holy DMG",
            "C": "M.DMG",
            "D": "Shadow DMG"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[DEFENDER] Shield-only skill. After activation, _____ taken -%, but MSPD -10% and ASPD -% for Xs. Cast again to remove this effect.",
        "options": {
            "A": "Ranged P.DMG",
            "B": "Melee P.DMG",
            "C": "Ranged M.DMG",
            "D": "All DMG"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[SACRIFICE] Shares % of damage taken by __________ for X sec. The effect is removed if the distance from the target exceeds X.Cannot be cast on another Crusader class or units already affected by Sacrifice",
        "options": {
            "A": "1 specified teammate",
            "B": "2 specified teammates",
            "C": "all alies within 10m",
            "D": "all allies within 15m"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[SPEAR QUICKEN] Spear-only skill. for X sec, ASPD +%, CRIT increases, and HIT increases. The effect is removed when __________.",
        "options": {
            "A": "leaving combat",
            "B": "equipping a non-Spear weapon",
            "C": "HP is below 20%",
            "D": "inflicted with Stun"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[REFLECT SHIELD] Passive: Takes effect while wielding a shield. When taking Melee P.DMG, reflects % of damage taken back to the attacker. After Reflect Shield reaches Lv.5, skill damage taken from monsters ___.\nActive: Shield-only skill. Melee P.DMG taken -%, and passive Melee P.DMG reflection +% for 8 sec.",
        "options": {
            "A": "-30%",
            "B": "-40%",
            "C": "-50%",
            "D": "-70%"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[PROVIDENCE] Calls down divine blessing, increasing __________ and DMG Reduction vs Demon by % for all teammates for X sec.",
        "options": {
            "A": "P.DMG Reduction",
            "B": "Holy DMG Reduction",
            "C": "M.DMG Reduction",
            "D": "Fire DMG Reduction"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[FORCED PROVOKE] Casting Provoke on players applies Taunt, forcing affected players to attack you for ___. Provoke cooldown ___.\nTargets already affected by Taunt cannot be Taunted again, and Crusaders are immune to Taunt.",
        "options": {
            "A": "5 sec / +8 sec",
            "B": "2 sec / +4 sec",
            "C": "5 sec / +4 sec",
            "D": "3 sec / +2 sec"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[DIVINE WRATH STRIKE] Releases divine power and slams the ground, dealing 1500%+40 Fire Melee P.DMG to enemies within 12 m. Has a 41% chance to reduce their P.ATK and ASPD by 10%, and enters Divine Wrath. During Divine Wrath, damage dealt +___% and Dmg Reduction +10% for 10 sec.",
        "options": {
            "A": "5",
            "B": "10",
            "C": "15",
            "D": "20"
        },
        "correctAnswer": "B"
    }
  ],
  "priest": [
    {
        "question": "[HOLY LIGHT lv10] Deals 520% + 165 Holy M.DMG to the target and up to __________.",
        "options": {
            "A": "5 enemies within 1.5 m",
            "B": "10 enemies within 1.5 m",
            "C": "5 enemies within 2.5 m",
            "D": "10 enemies within 2.5 m"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[HEAL lv10] Heals __________ for 450% * MATK + 235 HP. When cast on Undead-element, Undead-race, or Demon units, deals Holy M.DMG equal to 50% of the Healing amount.",
        "options": {
            "A": "1 specified allied unit",
            "B": "1 specified allied unit and you",
            "C": "allies within 2.5m",
            "D": "all party members"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[DEMON BANE lv5] Damage dealt to __________ targets +5%.",
        "options": {
            "A": "Enemy",
            "B": "Demon",
            "C": "Undead",
            "D": "Demon and Undead"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[BLESSING lv10] Increases STR, INT, and DEX for you and your teammates within 20 m by __________.",
        "options": {
            "A": "20",
            "B": "30",
            "C": "20, and HIT by 20",
            "D": "30, and HIT by 20"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[ANGELUS lv10] Reduces Fixed DMG taken by you and teammates within 20 m by ___, and increases Max HP by 500.",
        "options": {
            "A": "25%",
            "B": "25",
            "C": "10%",
            "D": "100"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[SIGNUM CRUCIUS lv10] Deals 330% + 115 Holy M.DMG to up to 5 enemies within 2 m, and reduces their M.DEF by __________. Demon and Undead enemies have M.DEF reduced by an additional 15%.",
        "options": {
            "A": "20% for 8 sec",
            "B": "30% for 8 sec",
            "C": "20% for 15 sec",
            "D": "30% for 15 sec"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[KYRIE ELEISON lv5] Adds a shield for you and your teammates within 20 m for 10 sec. The shield can block damage equal to __________.",
        "options": {
            "A": "25% Max HP, up to 10 hits",
            "B": "15% Max HP, up to 10 hits",
            "C": "15% Max HP, up to 20 hits",
            "D": "25% Max HP, up to 20 hits"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[INCREASE AGILITY lv5] When casting Blessing, also casts Increase Agility, granting you and allied teammates AGI +7, __________ for 600s.",
        "options": {
            "A": "Quicken Factor +10%, and MSPD +15%",
            "B": "Quicken Factor +15%, and MSPD +15%",
            "C": "Quicken Factor +15%, and MSPD +20%",
            "D": "Quicken Factor +20%, and MSPD +25%"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[TURN UNDEAD lv10] Deals 325% + 420 Holy M.DMG to the target. When used on Undead targets, has a _____ to instantly kill the target. This effect is ineffective against Elite monsters, Minis, MVPs, and Bosses.",
        "options": {
            "A": "30% chance",
            "B": "50% chance",
            "C": "70% chance",
            "D": "90% chance"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[RENOVATIO HAMMER lv10] Passive: When using a mace, Basic Attacks become 240% Holy Melee P.DMG and deal 100% splash damage to enemies within 1.5 m, but Quicken Factor gain from Basic Attacks is reduced by 50%.\nActive: Releases holy hammer power, dealing 600% + 440 Holy Melee P.DMG to the target and up to 5 enemies within 2.5 m. __________.",
        "options": {
            "A": "Holy DMG dealt +10% for the next 10 sec",
            "B": "Holy DMG dealt +20% for the next 20 sec",
            "C": "Holy DMG dealt +10% for the next 4 sec",
            "D": "Holy DMG dealt +20% for the next 4 sec"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[SANCTUARY lv10] Creates a Sanctuary on the ground for 8 sec. Each sec, Sanctuary heals you and up to 5 teammates in the area for _____ + 1200 HP. Undead-element, Undead-race, or Demon enemies entering the area take Holy M.DMG equal to 50% of the Healing amount every sec.",
        "options": {
            "A": "80% * MATK",
            "B": "100% * MATK",
            "C": "120% * MATK",
            "D": "130% * MATK"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[RECOVERY lv1] Randomly dispels __________ from nearby teammates.",
        "options": {
            "A": "1 debuff",
            "B": "2 debuffs",
            "C": "Stun and Freeze",
            "D": "Petrify and Silence"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[GLORIA lv5] Increases LUK for you and your teammates within 20 m by __________.",
        "options": {
            "A": "20 for 400 sec",
            "B": "20 for 600 sec",
            "C": "30 for 400 sec",
            "D": "30 for 600 sec"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[BLUNT WEAPON MASTERY lv10] When using a mace, __________.",
        "options": {
            "A": "P.ATK +30 and ASPD +30",
            "B": "P.ATK +30 and Holy DMG +30",
            "C": "P.ATK +30 and CRIT +30",
            "D": "P.ATK +30 and M.ATK +30"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[RESSURRECTION lv4] Revives 1 ally and restores __________.",
        "options": {
            "A": "60% HP and 60% SP",
            "B": "80% HP and 80% SP",
            "C": "80% HP and 100% SP",
            "D": "100% HP and 100% SP"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[IMPOSITO MAGNUS lv5] Increases P.ATK and MATK for you and your teammates within 20 m by __________.",
        "options": {
            "A": "30 for 300 sec",
            "B": "40 for 400 sec",
            "C": "50 for 500 sec",
            "D": "60 for 600 sec"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[ASPERSIO lv3] Grants Holy element to the weapons for you and your teammates within 20 m, and increases DMG vs Undead and Demon by ________.",
        "options": {
            "A": "8% for 200 sec",
            "B": "10% for 200 sec",
            "C": "10% for 300 sec",
            "D": "12% for 300 sec"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[MAGNUS EXORCISMUS lv10] Creates a 4.5 m cross on the ground for 14 sec, dealing 1040%+285 Holy M.DMG every sec to up to 10 targets within 3.5 m. P.Dmg Bonus and M.Dmg Bonus increase by 30% when dealing damage to Demon, Undead, Shadow, or Undead-element targets. Up to __________ can exist at the same time.",
        "options": {
            "A": "1 Magnus Exorcismus fields",
            "B": "2 Magnus Exorcismus fields",
            "C": "3 Magnus Exorcismus fields",
            "D": "4 Magnus Exorcismus fields"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[SAFETY WALL lv5] Sets up a barrier for 3.5 sec, blocks any P.DMG for up to 5 teammates standing inside, up to 40 times.\nCannot block damage from __________.",
        "options": {
            "A": "Players",
            "B": "Holy Monsters",
            "C": "MVPs or Minis",
            "D": "MVPs or Bosses"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[SACRED LIGHT TREE] Summons 1 Holy Tree, clearing abnormal statuses from all nearby teammates and healing all teammates in range for 150%*MATK HP every sec. Teammates in range gain Max HP +15% for 10 sec. After summoning, reduces your damage taken by 5% for 6 sec. After successfully casting this Ultimate Skill, gains the Tree of Life's Blessing, allowing you to revive once upon death within the next ___ of combat",
        "options": {
            "A": "3 sec",
            "B": "5 sec",
            "C": "7 sec",
            "D": "10 sec"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[SUFFRAGIUM lv3] Reduces Variable Cast Time for you and your teammates within 20 m by ___ for 600 sec.",
        "options": {
            "A": "10%",
            "B": "20%",
            "C": "30%",
            "D": "40%"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[RUWACH] Summons holy spirits around you, revealing hidden targets within 3 m for ___.",
        "options": {
            "A": "8 sec",
            "B": "10 sec",
            "C": "15 sec",
            "D": "30 sec"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[SPELL MASTERY] Casting can __________.",
        "options": {
            "A": "be interrupted by movement",
            "B": "increase heal recovery by 20%",
            "C": "increase movement speed briefly",
            "D": "form a shield around you for 5 sec"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[INCREASE SP RECOVERY] Restores ___ SP every 5 sec.",
        "options": {
            "A": "2%",
            "B": "4%",
            "C": "5%",
            "D": "8%"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[B.S SACRAMENTI] Performs a holy ritual, applying all learned blessing skill effects except ______ to you and nearby allies.",
        "options": {
            "A": "Basilica",
            "B": "Demon Bane",
            "C": "Aspersio",
            "D": "Gloria"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[JUDEX lv10] Deals 1660% + 510 Holy M.DMG to the target and up to __________.",
        "options": {
            "A": "5 enemies within 2 m",
            "B": "10 enemies within 2 m",
            "C": "5 enemies within 3.5 m",
            "D": "10 enemies within 2 m"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[DUPLE LIGHT lv10] Strikes enemies with Duple Light using a holy hammer, dealing 2 hits of 400% + 400 Holy Melee P.DMG to the target and enemies within 1.5 m. This skill has __________.",
        "options": {
            "A": "2 charges",
            "B": "3 charges",
            "C": "4 charges",
            "D": "5 charges"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[COLUSEO HEAL lv5] Calls down holy light, restoring 1100% * MATK + 720 HP to you and teammates within 15 m, and randomly __________.",
        "options": {
            "A": "dispelling 1 debuffs",
            "B": "dispelling 2 debuffs",
            "C": "refreshing 1 party buff",
            "D": "dispelling all debuffs"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[ASSUMPTION lv5] Increases P.ATK and MATK for you and your teammates within 20 m by ___ for 600 sec.",
        "options": {
            "A": "8%",
            "B": "10%",
            "C": "12%",
            "D": "15%"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[MANA RECHARGE lv10] Reduces SP cost by ___ when using skills.",
        "options": {
            "A": "10%",
            "B": "15%",
            "C": "20%",
            "D": "25%"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[COLUSEO HEAL (PASSIVE) lv10] Coluseo Heal's Healing +___.",
        "options": {
            "A": "30%",
            "B": "25%",
            "C": "20%",
            "D": "15%"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[LEX AETERNA lv5] Increases __________ taken by the target within 6 sec by 100%.",
        "options": {
            "A": "final DMG",
            "B": "Holy DMG",
            "C": "all DMG",
            "D": "the next damage"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[BASILICA lv10] Casts holy power to protect allies, further reducing damage taken by all allied teammates within 15 m by __________. After the effect ends, they cannot receive the protection of Basilica again for 60 sec.",
        "options": {
            "A": "50% for 5 sec",
            "B": "60% for 5 sec",
            "C": "80% for 5 sec",
            "D": "90% for 5 sec"
        },
        "correctAnswer": "C"
    }
  ],
  "wizard": [
    {
        "question": "[FIREBOLT lv10] Summons 10 fire arrows to attack the target. Each fire arrow deals ___% + 20 Fire M.DMG.",
        "options": {
            "A": "80%",
            "B": "100%",
            "C": "120%",
            "D": "150%"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[LIGHTNING BOLT lv10] Summons lightning to attack the target, dealing ___% + 200 Wind M.DMG.",
        "options": {
            "A": "1000%",
            "B": "1100%",
            "C": "1200%",
            "D": "1300%"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[COLD BOLT lv10] Summons 10 ice arrows to attack the target. Each ice arrow deals ___% + 20 Water M.DMG.",
        "options": {
            "A": "80%",
            "B": "100%",
            "C": "120%",
            "D": "150%"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[STONE CURSE lv10] Deals 200%+110 Earth M.DMG to the target, with an __________.",
        "options": {
            "A": "65% chance to Petrify for 2.8 sec",
            "B": "65% chance to Petrify for 3.8 sec",
            "C": "80% chance to Petrify for 2.8 sec",
            "D": "80% chance to Petrify for 3.8 sec"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[NAPALM BEAT lv10] Detonates the target enemy with psychic power, dealing 500% + 300 Ghost M.DMG to the target and __________. Damage is evenly split among all targets.",
        "options": {
            "A": "up to 10 enemies within 4.5 m",
            "B": "up to 10 enemies within 3 m",
            "C": "up to 5 enemies within 4.5 m",
            "D": "up to 5 enemies within 3 m"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[FIREBALL lv10] Shoots a fireball at the target, dealing 640% + 230 Fire M.DMG to the target and up to 5 enemies within 4 m. Targets more than __________.",
        "options": {
            "A": "1.5 m from the center take 50% damage",
            "B": "1.5 m from the center take 65% damage",
            "C": "1.5 m from the center take 75% damage",
            "D": "1.5 m from the center take 100% damage"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[THUNDERSTORM lv10] Calls down lightning from the sky, dealing 720% + 300 Wind M.DMG to __________.",
        "options": {
            "A": "up to 5 enemies within 2.5 m",
            "B": "up to 5 enemies within 3.5 m",
            "C": "up to 10 enemies within 2.5 m",
            "D": "up to 10 enemies within 3.5 m"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[FROST DIVER lv10] Deals 200% + 100 Water M.DMG to the target, with a __________.",
        "options": {
            "A": "85% chance to inflict Freeze for 2.6 sec",
            "B": "85% chance to inflict Freeze for 4.6 sec",
            "C": "65% chance to inflict Freeze for 2.6 sec",
            "D": "65% chance to inflict Freeze for 4.6 sec"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[SOUL STRIKE lv10] Summons holy spirits to attack, dealing a total of 700% + 250 _____ to the target.",
        "options": {
            "A": "Neutral M.DMG",
            "B": "Holy M.DMG",
            "C": "Ghost M.DMG",
            "D": "Shadow M.DMG"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[FIREWALL lv10] Creates a 3 m Fire Wall, dealing 50% + 50 Fire M.DMG to up to 5 enemies entering the area and knocking them back. Lasts 14 sec. Up to__________ can exist at the same time.",
        "options": {
            "A": "2 Fire Walls",
            "B": "3 Fire Walls",
            "C": "4 Fire Walls",
            "D": "5 Fire Walls"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[ENERGY COAT] Guards the body with spiritual energy. Each time damage is taken, consumes 1% SP to further reduce damage by ___. Lasts 600 sec.",
        "options": {
            "A": "12%",
            "B": "10%",
            "C": "8%",
            "D": "6%"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[INCREASE SP RECOVERY] Restores ___ SP every 5 sec.",
        "options": {
            "A": "0.50%",
            "B": "0.75%",
            "C": "1%",
            "D": "1.50%"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[FIRE PILLAR lv10] Sets a fire pillar at the target location, dealing _____ + 600 Fire M.DMG to up to 5 enemies within 2 m.",
        "options": {
            "A": "1000%",
            "B": "1200%",
            "C": "1500%",
            "D": "1800%"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[JUPITEL THUNDER lv10] Launches an electric orb at the target, dealing ___ + 480 Wind M.DMG and knocking them back 5 m. Knockback is ineffective against players.",
        "options": {
            "A": "1000%",
            "B": "1200%",
            "C": "1500%",
            "D": "1800%"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[WATERBALL lv5] Launches a water ball at the target, dealing ____ + 520 Water M.DMG.",
        "options": {
            "A": "1000%",
            "B": "1100%",
            "C": "1200%",
            "D": "1300%"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[EARTH SPIKE lv5] Raises rocks from the ground, dealing ___ + 200 Earth M.DMG to the target enemy.",
        "options": {
            "A": "1000%",
            "B": "1100%",
            "C": "1200%",
            "D": "1300%"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[LORD OF VERMILION lv10] Calls down __________ in the target area. Each strike deals 800%+200 Wind M.DMG to up to 10 enemies within 3.5 m, with a 60% chance to inflict Blind for 2.5 sec.",
        "options": {
            "A": "8 lightning strikes",
            "B": "6 lightning strikes",
            "C": "4 lightning strikes",
            "D": "2 lightning strikes"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[FROST NOVA lv10] Unleashes frost around you, dealing 650% + 350 Water M.DMG to __________, with an 86% chance to inflict Freeze for 3 sec.",
        "options": {
            "A": "up to 5 enemies within 4.5 m",
            "B": "up to 5 enemies within 3.5 m",
            "C": "up to 10 enemies within 4.5 m",
            "D": "up to 10 enemies within 3.5 m"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[HEAVEN'S DRIVE lv10] Raises the ground at the target location, dealing 780% + 390 Earth M.DMG to __________.",
        "options": {
            "A": "up to 10 enemies within 3 m",
            "B": "up to 8 enemies within 3 m",
            "C": "up to 5 enemies within 4.5 m",
            "D": "up to 5 enemies within 3 m"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[METEOR STORM lv10] Drops 7 meteors in the target area. Each meteor deals 625% + 400 Fire M.DMG to up to 10 enemies within 3 m, with a __________.",
        "options": {
            "A": "15% chance to Stun for 2 sec",
            "B": "15% chance to Stun for 1 sec",
            "C": "25% chance to Stun for 2 sec",
            "D": "25% chance to Stun for 1 sec"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[STORM GUST lv10] Summons a Storm Gust in the target area for 4.5 sec. Every _____, deals 210%+250Water M.DMG to up to 10 enemies within 4.5 m, with a 42% chance to inflict Freeze for 2.5 sec.",
        "options": {
            "A": "1 sec",
            "B": "0.6 sec",
            "C": "0.45 sec",
            "D": "0.25 sec"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[QUAGMIRE lv5] Creates a Quagmire at the target location for 10 sec, reducing MSPD of up to 10 enemies within 3 m by ___, and reducing AGI and DEX by ___. Up to 2 Quagmires can exist at the same time.",
        "options": {
            "A": "50% / 30",
            "B": "40% / 30",
            "C": "30% / 20",
            "D": "20% / 20"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[SIGHT] Summons flames around you, revealing hidden enemies within 7 m for _____.",
        "options": {
            "A": "10 sec",
            "B": "12 sec",
            "C": "16 sec",
            "D": "20 sec"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[FOCUS SPELL] Variable Cast Time -35%; When dealing Wind, Earth, Water, Fire, or Ghost Elemental Dmg to monsters, __________ to treat it as the corresponding weakness.",
        "options": {
            "A": "10% chance",
            "B": "20% chance",
            "C": "30% chance",
            "D": "35% chance"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[SPELL MASTERY] Casting can be __________.",
        "options": {
            "A": "continued under abnormal effect",
            "B": "interrupted by movement",
            "C": "persisted with slow movement",
            "D": "done while mounted"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[NAPALM VULCAN lv10] Strikes the target _____ with psychic power. Each hit deals 260% + 150 Ghost M.DMG. After Napalm Vulcan exceeds Lv.10, each level increases the burst skill damage of the Special Skill \"Psychic Fission\".",
        "options": {
            "A": "10 times",
            "B": "7 times",
            "C": "5 times",
            "D": "3 times"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[SOUL DRAIN lv10] Permanently increases Max SP by 40%. When killing an enemy, restores _____.",
        "options": {
            "A": "6.5% SP",
            "B": "7.5% SP",
            "C": "9% SP",
            "D": "11% SP"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[FLAME MASTERY lv10] When Flame skills deal damage, applies Burn to the target, dealing 360% Fire M.DMG every 0.8 sec. Burn increases Skill DMG to monsters by ___.",
        "options": {
            "A": "10%",
            "B": "15%",
            "C": "20%",
            "D": "25%"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[FROST MASTERY lv10] When applying Freeze, increases its control chance and duration by 20%. Water DMG dealt is __________, and Frost skills deal 30% more Skill DMG to monsters.",
        "options": {
            "A": "double to the target",
            "B": "shared with nearby targets",
            "C": "applied with elemental advantage",
            "D": "not reduced by elemental disadvantage"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[STORM MASTERY lv10] When casting Storm skills, applies 2 stacks of Electrocution to you. While affected by Electrocution, consumes __________ and casts Chain Lightning on the nearest nearby target, bouncing between 5 enemies and dealing 820%+350 Wind M.DMG. Electrocution lasts 10 sec and stacks up to 6 times.\nChain Lightning deals 20% increased Skill DMG to monsters.",
        "options": {
            "A": "1 stack every 1.0 sec",
            "B": "1 stack every 1.5 sec",
            "C": "1 stack every 0.5 sec",
            "D": "1 stack every 2.0 sec"
        },
        "correctAnswer": "C"
    },
    {
        "question": "[MYSTICAL AMPLIFICATION lv10] Increases your own magic Skill DMG by ___ and reduces Variable Cast Time by 20% for 10 sec.",
        "options": {
            "A": "8%",
            "B": "10%",
            "C": "12%",
            "D": "15%"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[SIENNA EXECRATE lv10] Casts Sienna Execrate on enemies in the target area, dealing 810% + 760 Earth M.DMG to up to 10 enemies within 4 m, with an __________ for 3 sec.",
        "options": {
            "A": "60% chance to inflict Petrify",
            "B": "60% chance to inflict Stun",
            "C": "80% chance to inflict Stun",
            "D": "80% chance to inflict Petrify"
        },
        "correctAnswer": "D"
    },
    {
        "question": "[GANBANTEIN lv1] Has an 80% chance to remove traps and field spell effects from up to 10 enemies within ___ of the target location.",
        "options": {
            "A": "2.5 m",
            "B": "3.5 m",
            "C": "4.0 m",
            "D": "4.5 m"
        },
        "correctAnswer": "A"
    },
    {
        "question": "[GRAVITATIONAL FIELD lv10] Greatly increases gravity in the target area, dealing 1500% + 1000 __________ to up to 10 enemies within a 4 m radius.",
        "options": {
            "A": "Ghost M.DMG",
            "B": "Neutral M.DMG",
            "C": "Holy M.DMG",
            "D": "Ranged P.DMG"
        },
        "correctAnswer": "B"
    },
    {
        "question": "[ELEMENTAL MASTERY] Summons Elemental Crystals in the target area, attacking up to 10 enemies within___ once each with Ghost, Fire, Earth, Water, and Wind elements in sequence. Each hit deals 315% + 8 M.DMG of the corresponding element, with a 50% chance to apply Silence, Curse, Stun, Freeze, and Vulnerable respectively for 4 sec.",
        "options": {
            "A": "4 m",
            "B": "5 m",
            "C": "6 m",
            "D": "8 m"
        },
        "correctAnswer": "C"
    }
  ]
};

/**
 * Return a random question for the given channel key.
 * Returns null if the key has no bank (druid, unknown future classes).
 */
function getRandomQuestion(channelKey) {
  const bank = QUESTIONS[channelKey];
  if (!bank || bank.length === 0) return null;
  return bank[Math.floor(Math.random() * bank.length)];
}

module.exports = { QUESTIONS, getRandomQuestion };
