import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @Length(1, 30)
  nickname?: string;

  @IsOptional()
  @IsString()
  avatar?: string;

  @IsOptional()
  @IsInt()
  @Min(18)
  @Max(99)
  age?: number;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  signature?: string;

  @IsOptional()
  @IsString()
  cityCode?: string;

  @IsOptional()
  @IsString()
  cityName?: string;

  /** 视频见面开关（默认关；双方都打开才能互相发起视频通话） */
  @IsOptional()
  @IsBoolean()
  allowVideo?: boolean;
}

export class UpdateAlbumsDto {
  /** 照片墙 URL 列表，最多 8 张，整组替换 */
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  photos!: string[];
}
