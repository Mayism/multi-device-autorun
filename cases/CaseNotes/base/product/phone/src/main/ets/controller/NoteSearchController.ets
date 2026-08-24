import { NoteService, SortEnum } from '@ohos_agcit/notes_datasource';
import { Note } from 'richeditor';

@ObservedV2
export class NoteSearchController {
  noteService: NoteService = NoteService.instance;
  private static _instance: NoteSearchController;

  public static get instance() {
    if (!NoteSearchController._instance) {
      NoteSearchController._instance = new NoteSearchController();
    }
    return NoteSearchController._instance;
  }

  controller: SearchController = new SearchController();
  @Trace searchKeyword: string = ''; // 搜索关键词
  @Trace isSearching: boolean = false; // 是否正在搜索状态

  @Trace dumpsterSearchKeyword: string = '';  // 专门用于回收站的关键词
  @Trace isDumpsterSearching: boolean = false;

  // 回收站搜索
  onDumpsterSearch(keyword: string): Note[] {
    this.dumpsterSearchKeyword = keyword.trim();
    this.isDumpsterSearching = this.dumpsterSearchKeyword.length > 0;
    return this.getSortedDumpsterList();
  }

  // 获取回收站列表（带搜索过滤）
  getSortedDumpsterList(): Note[] {
    return this.isDumpsterSearching
      ? this.noteService.searchInDumpsters(this.dumpsterSearchKeyword) || []
      : this.noteService.getDumpstersData();
  }

  // 添加搜索方法
  onSearch(categoryId: string, keyword: string, sortBy: SortEnum): Note[]{
    this.searchKeyword = keyword.trim();
    this.isSearching = this.searchKeyword.length > 0;
    // 执行搜索
    return this.noteService.getNoteList(categoryId, sortBy, this.searchKeyword);
  }
}

