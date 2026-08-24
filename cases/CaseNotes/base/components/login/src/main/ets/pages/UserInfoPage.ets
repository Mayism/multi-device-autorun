import { UserInfoForm } from './UserInfoForm';

@Builder
export function UserInfoBuilder() {
  UserInfoPage();
}

@ComponentV2
export struct UserInfoPage {
  @Consumer('appPathStack') appPathStack: NavPathStack = new NavPathStack();

  build() {
    NavDestination() {
      UserInfoForm();
    }
    .title('个人信息')
    .onBackPressed(() => {
      this.appPathStack.pop();
      return true;
    });
  }
}
