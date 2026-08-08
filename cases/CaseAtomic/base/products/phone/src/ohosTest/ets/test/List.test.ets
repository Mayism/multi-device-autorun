import splitScrollTest from './SplitScroll.test';
import splitDialogTest from './SplitDialog.test';
import splitImageTest from './SplitImage.test';
import splitTabTest from './SplitTab.test';
import splitVideoTest from './SplitVideo.test';

export default function testsuite() {
  splitImageTest();
  splitDialogTest();
  splitTabTest();
  splitVideoTest();
  splitScrollTest();
}