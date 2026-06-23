// ---------------------------------------------------------------------------
// Shared constants for the job-ad -> officer-application feature.
// ---------------------------------------------------------------------------

// customId namespace tokens. Kept here so command + handlers agree.
// Flow chain:
//   jobad:modal                         (leadership posts a job ad)
//   jobapply:<jobAdMessageId>           (applicant clicks Apply on the ad)
//   officerapp:modal:<jobAdMessageId>   (applicant submits the officer app)
//   officerreview:<action>:<applicantUserId>:<jobAdMessageId>  (leadership reviews)
const IDS = {
  JOBAD_MODAL:     'jobad:modal',        // the 2-input job-ad modal (Title / Description)
  APPLY_PREFIX:    'jobapply',           // jobapply:<jobAdMessageId>
  APP_MODAL_PREFIX:'officerapp:modal',   // officerapp:modal:<jobAdMessageId>
  REVIEW_PREFIX:   'officerreview',      // officerreview:<action>:<applicantUserId>:<jobAdMessageId>
};

// Channel the officer-application embed is posted to for review (#officer-applications).
const OFFICER_APP_CHANNEL_ID = '1518882017075269752';

// Channel job ads are posted to (#job-ad).
const JOB_AD_CHANNEL_ID = '1518891573411315773';

// Role IDs permitted to APPLY (the three applicant roles). A member must hold
// at least one of these to use the Apply button.
const OFFICER_APPLICANT_ROLE_IDS = [
  '1518076150692188200',
  '1518076953595351191',
  '1518664863621320817',
];

// Modal text-input customIds.
const FIELDS = {
  // job-ad modal
  AD_TITLE:       'ad_title',
  AD_DESCRIPTION: 'ad_description',
  // officer-application modal
  IGN:            'ign',
  WHY_FIT:        'whyfit',
};

// Officer role IDs granted on approval. Daddy and Mummy are distinct tiers.
const OFFICER_ROLE_IDS = {
  DADDY: '1518076612787048548',
  MUMMY: '1518666580903329822',
};

module.exports = {
  IDS,
  FIELDS,
  OFFICER_APP_CHANNEL_ID,
  JOB_AD_CHANNEL_ID,
  OFFICER_APPLICANT_ROLE_IDS,
  OFFICER_ROLE_IDS,
};
